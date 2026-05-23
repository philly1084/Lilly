/**
 * Agent SDK Tools - Main Entry Point
 * Loads and registers all tool categories
 */

const { getUnifiedRegistry } = require('../registry/UnifiedRegistry');
const { getAgentBus } = require('../agents/AgentBus');
const { readToolDoc, getToolDocMetadata } = require('../tool-docs');
const { generateImageBatch } = require('../../openai-client');
const { searchImages, isConfigured: isUnsplashConfigured } = require('../../unsplash-client');
const { persistGeneratedImages } = require('../../generated-image-artifacts');
const {
  buildImageGenerationDiagnostics,
  countUsableImageRecords,
  formatImageDiagnosticsSummary,
} = require('../../image-generation-diagnostics');
const { persistGeneratedAudio } = require('../../generated-audio-artifacts');
const { artifactService } = require('../../artifacts/artifact-service');
const { assetManager } = require('../../asset-manager');
const { researchBucketService } = require('../../research-buckets');
const { publicSourceIndexService, SOURCE_KINDS, STATUSES } = require('../../public-source-index');
const { ttsService } = require('../../tts/tts-service');
const { audioProcessingService } = require('../../audio/audio-processing-service');
const { podcastService } = require('../../podcast/podcast-service');
const { podcastVideoService } = require('../../video/podcast-video-service');
const { config } = require('../../config');
const { isDashboardRequest } = require('../../dashboard-template-catalog');
const {
  ensureFrontendBundleStyling,
  normalizeBundlePath,
  normalizeFrontendBundle,
} = require('../../frontend-bundles');
const { buildSandboxBrowserLibraryInstructions } = require('../../sandbox-browser-libraries');
const { escapeHtml, normalizeWhitespace, stripHtml } = require('../../utils/text');
const { mergeMemoryKeywords, normalizeMemoryKeywords } = require('../../memory/memory-keywords');
const {
  AGENT_NOTES_CHAR_LIMIT,
  writeAgentNotesFile,
} = require('../../agent-notes');
const {
  SELF_REFLECTION_UPDATE_ACTION_LIMIT,
  SELF_REFLECTION_UPDATE_TOOL_ID,
  applySelfReflectionUpdate,
} = require('../../self-reflection-updater');
const {
  hasSchedulingCue,
  summarizeTrigger,
} = require('../../workloads/natural-language');
const {
  buildCanonicalWorkloadPayload,
  extractWorkloadScenarioSource,
} = require('../../workloads/request-builder');
const {
  USER_CHECKPOINT_TOOL_ID,
  normalizeCheckpointRequest,
  buildUserCheckpointMessage,
} = require('../../user-checkpoints');
const { skillStore } = require('../../skills/skill-store');
const { buildToolContract } = require('../../orchestration/tool-contracts');
const {
  READINESS_DEGRADED,
  READINESS_READY,
  READINESS_UNAVAILABLE,
  summarizeToolReadiness,
} = require('../../orchestration/tool-readiness');
const { classifyFailureText } = require('../../orchestration/recovery-policy');
const { validatePlanStep } = require('../../orchestration/plan-validator');
const { getHostnameFromUrl, normalizeDomainList } = require('./categories/web/research-site-policy');
const {
  RELATIONSHIP_CALCULATION_TOOL_ID,
  RELATIONSHIP_CALCULATION_SCHEMA,
  calculateRelationshipWithRepair,
} = require('../../pii');

const MAX_VERIFIED_REFERENCE_IMAGES = 20;
const IMAGE_REFERENCE_VERIFY_TIMEOUT_MS = 15000;
const DOCUMENT_WORKFLOW_TOOL_ID = 'document-workflow';
const DEEP_RESEARCH_PRESENTATION_TOOL_ID = 'deep-research-presentation';
const MAX_DOCUMENT_SOURCES = 20;
const MAX_DOCUMENT_SUITE_FORMATS = 8;
const MAX_DOCUMENT_SOURCE_CHARS = Math.max(
  8000,
  Math.min(Number(config.memory?.toolResultCharLimit) || 120000, parseInt(process.env.DOCUMENT_SOURCE_CHARS, 10) || 20000),
);
const DEFAULT_DEEP_RESEARCH_PASSES = 3;
const MAX_DEEP_RESEARCH_PASSES = 6;
const MAX_DEEP_RESEARCH_SEARCH_LIMIT = Math.max(
  8,
  Number(config.search?.maxLimit || MAX_VERIFIED_REFERENCE_IMAGES),
);
const DEFAULT_DEEP_RESEARCH_SEARCH_LIMIT = Math.min(
  MAX_DEEP_RESEARCH_SEARCH_LIMIT,
  Math.max(1, Number(config.memory?.researchSearchLimit || 16)),
);
const DEFAULT_DEEP_RESEARCH_PAGES_PER_PASS = Math.min(
  8,
  Math.max(1, Number(config.memory?.researchFollowupPages || 6)),
);
const MAX_DEEP_RESEARCH_PAGES_PER_PASS = 8;
const DEFAULT_DEEP_RESEARCH_IMAGE_LIMIT = 4;

function resolveManagedAppService(context = {}) {
  if (context.managedAppService) {
    return context.managedAppService;
  }
  const { ManagedAppService } = require('../../managed-apps/service');
  return new ManagedAppService();
}
const MAX_DEEP_RESEARCH_IMAGE_LIMIT = 6;
const DEFAULT_IMAGE_SETTLE_DELAY_MS = 1500;
const DEFAULT_DEEP_RESEARCH_RECALL_TOP_K = 4;
const MAX_DEEP_RESEARCH_QUERY_KEYWORDS = 5;

// Tool categories
const { registerWebTools } = require('./categories/web');
const { registerDesignTools } = require('./categories/design');
const { registerDatabaseTools } = require('./categories/database');
const { registerSandboxTools } = require('./categories/sandbox');
// SSH tools
const { SSHExecuteTool } = require('./categories/ssh/SSHExecuteTool');
const { RemoteWorkbenchTool } = require('./categories/ssh/RemoteWorkbenchTool');
const { DockerExecTool } = require('./categories/ssh/DockerExecTool');
const { K3sDeployTool } = require('./categories/ssh/K3sDeployTool');
const { RemoteCliAgentTool } = require('./categories/ssh/RemoteCliAgentTool');
const { GitLocalTool } = require('./categories/system/GitLocalTool');

function normalizeCandidateUrl(value = '') {
  let candidate = String(value || '').trim();
  if (!candidate) {
    throw new Error('Image URL is required.');
  }

  const markdownMatch = candidate.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
  if (markdownMatch) {
    candidate = markdownMatch[1] || markdownMatch[2] || candidate;
  }

  const bracketMatch = candidate.match(/<(https?:\/\/[^>\s]+)>/i);
  if (bracketMatch?.[1]) {
    candidate = bracketMatch[1];
  }

  const plainUrlMatch = candidate.match(/https?:\/\/\S+/i);
  if (plainUrlMatch?.[0]) {
    candidate = plainUrlMatch[0];
  }

  while (/[),.;!?'"`\]]$/.test(candidate)) {
    const next = candidate.slice(0, -1);
    if (!next) break;
    candidate = next;
  }

  return candidate;
}

function deriveImageAltText(urlString = '', fallback = 'image') {
  try {
    const parsed = new URL(urlString);
    const fileName = parsed.pathname.split('/').pop() || '';
    const normalized = fileName
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();

    return normalized || fallback;
  } catch (_error) {
    return fallback;
  }
}

function hasLikelyImageExtension(urlString = '') {
  return /\.(png|jpe?g|gif|webp|svg|avif)(?:[?#].*)?$/i.test(String(urlString || '').trim());
}

function isImageMimeType(mimeType = '') {
  return String(mimeType || '').trim().toLowerCase().startsWith('image/');
}

function readImageMimeType(response) {
  return String(response?.headers?.get?.('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

async function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === 'function') {
      await response.body.cancel();
    }
  } catch (_error) {
    // Ignore best-effort cleanup failures.
  }
}

async function verifyDirectImageUrl(urlString = '', timeoutMs = IMAGE_REFERENCE_VERIFY_TIMEOUT_MS) {
  if (typeof fetch !== 'function') {
    throw new Error('Image URL verification requires fetch support in the runtime.');
  }

  const headers = {
    'User-Agent': 'KimiBuilt-Agent/1.0',
    Accept: 'image/*,*/*;q=0.8',
  };
  const attempts = [
    { method: 'HEAD', headers },
    {
      method: 'GET',
      headers: {
        ...headers,
        Range: 'bytes=0-0',
      },
    },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    let response;

    try {
      response = await fetch(urlString, {
        method: attempt.method,
        headers: attempt.headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const finalUrl = response.url || urlString;
      const mimeType = readImageMimeType(response);
      const verified = isImageMimeType(mimeType) || (!mimeType && hasLikelyImageExtension(finalUrl));
      await cancelResponseBody(response);

      if (!verified) {
        throw new Error(
          `URL did not resolve to a verified image file (content-type: ${mimeType || 'unknown'})`,
        );
      }

      return {
        url: finalUrl,
        mimeType: mimeType || null,
        verificationMethod: attempt.method,
      };
    } catch (error) {
      await cancelResponseBody(response);
      lastError = error;
    }
  }

  throw lastError || new Error('Failed to verify image URL.');
}

function normalizeInlineFileContent(value) {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_error) {
      return String(value);
    }
  }

  return String(value);
}

function normalizeFileWriteParams(params = {}) {
  const normalized = params && typeof params === 'object'
    ? { ...params }
    : {};
  const pathCandidates = [
    normalized.path,
    normalized.filePath,
    normalized.filepath,
    normalized.filename,
    normalized.targetPath,
    normalized.destination,
  ];
  const resolvedPath = pathCandidates.find((value) => typeof value === 'string' && value.trim());
  if (resolvedPath) {
    normalized.path = resolvedPath.trim();
  }

  if (!Object.prototype.hasOwnProperty.call(normalized, 'content')) {
    const contentCandidates = [
      normalized.contents,
      normalized.text,
      normalized.body,
      normalized.data,
      normalized.html,
      normalized.source,
      normalized.code,
      normalized.markdown,
      normalized.fileContent,
    ];
    const resolvedContent = contentCandidates
      .map((value) => normalizeInlineFileContent(value))
      .find((value) => typeof value === 'string');

    if (typeof resolvedContent === 'string') {
      normalized.content = resolvedContent;
    }
  } else {
    normalized.content = normalizeInlineFileContent(normalized.content);
  }

  return normalized;
}

function inferFileWriteArtifactExtension(targetPath = '') {
  const path = require('path');
  return path.extname(String(targetPath || '')).replace(/^\./, '').trim().toLowerCase() || 'txt';
}

function inferFileWriteArtifactMimeType(extension = '') {
  const normalized = String(extension || '').trim().toLowerCase();
  const mimeByExtension = {
    css: 'text/css',
    csv: 'text/csv',
    htm: 'text/html',
    html: 'text/html',
    js: 'text/javascript',
    json: 'application/json',
    markdown: 'text/markdown',
    md: 'text/markdown',
    mermaid: 'text/vnd.mermaid',
    mjs: 'text/javascript',
    mmd: 'text/vnd.mermaid',
    txt: 'text/plain',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
  };

  return mimeByExtension[normalized] || 'text/plain';
}

function buildFileWriteArtifactPreviewHtml(extension = '', content = '') {
  const normalizedExtension = String(extension || '').trim().toLowerCase();
  const source = String(content || '');

  if (!source) {
    return '';
  }

  if (normalizedExtension === 'html' || normalizedExtension === 'htm') {
    return source;
  }

  return `<pre>${escapeHtml(source.slice(0, 12000))}</pre>`;
}

async function persistFileWriteArtifact({
  sessionId,
  sourceMode = 'chat',
  targetPath = '',
  content = '',
} = {}) {
  if (!sessionId) {
    return null;
  }

  const path = require('path');
  const extension = inferFileWriteArtifactExtension(targetPath);
  const filename = path.basename(String(targetPath || '').trim()) || `generated-file.${extension}`;
  const normalizedContent = String(content || '').replace(/\r\n?/g, '\n');
  const storedArtifact = await artifactService.createStoredArtifact({
    sessionId,
    direction: 'generated',
    sourceMode,
    filename,
    extension,
    mimeType: inferFileWriteArtifactMimeType(extension),
    buffer: Buffer.from(normalizedContent, 'utf8'),
    extractedText: normalizedContent,
    previewHtml: buildFileWriteArtifactPreviewHtml(extension, normalizedContent),
    metadata: {
      createdByAgentTool: true,
      originalFilename: filename,
      toolId: 'file-write',
      ...(extension === 'mermaid' || extension === 'mmd'
        ? { mermaidSource: normalizedContent }
        : {}),
    },
    vectorize: false,
  });

  return artifactService.serializeArtifact(storedArtifact);
}

function resolveArtifactSourceMode(context = {}) {
  const route = String(context?.route || '').trim().toLowerCase();
  if (route === '/api/canvas') {
    return 'canvas';
  }
  if (route === '/api/notation') {
    return 'notation';
  }
  return String(context?.taskType || context?.mode || 'chat').trim() || 'chat';
}

function normalizeWorkloadAction(value = '') {
  return String(value || '').trim().toLowerCase() || 'create_from_scenario';
}

function resolveSessionWorkloadService(context = {}) {
  const service = context?.workloadService || null;
  if (!service?.isAvailable?.()) {
    throw new Error('Deferred workloads are unavailable. This feature requires an active Postgres-backed session store.');
  }

  const ownerId = String(context?.ownerId || '').trim();
  const sessionId = String(context?.sessionId || '').trim();
  if (!ownerId) {
    throw new Error('Deferred workloads require an authenticated owner context.');
  }
  if (!sessionId) {
    throw new Error('Deferred workloads require an active session context.');
  }

  return {
    service,
    ownerId,
    sessionId,
  };
}

function hasExplicitManualWorkloadIntent(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    /\bmanual\b/,
    /\bon[- ]demand\b/,
    /\bwhen i (?:run|trigger|start|launch) it\b/,
    /\bi(?:'d| would)? trigger it\b/,
    /\bdo not schedule\b/,
    /\bdon't schedule\b/,
    /\bwithout scheduling\b/,
    /\bnot scheduled\b/,
    /\bunscheduled\b/,
  ].some((pattern) => pattern.test(normalized));
}

function extractScenarioSource(params = {}) {
  return extractWorkloadScenarioSource(params);
}

function assertWorkloadSchedulingIntent(params = {}, context = {}) {
  const scenarioSource = extractScenarioSource(params);
  const triggerType = String(params.trigger?.type || '').trim().toLowerCase();
  const explicitManual = hasExplicitManualWorkloadIntent(scenarioSource);

  if (triggerType === 'cron' || triggerType === 'once') {
    return;
  }

  if (triggerType === 'manual') {
    if (!explicitManual) {
      throw new Error('Manual workload creation needs an explicit manual request. Add a time or recurrence for scheduled work.');
    }
    return;
  }

  if (hasSchedulingCue(scenarioSource)) {
    return;
  }

  if (explicitManual) {
    return;
  }

  throw new Error('Workload creation needs a schedule. Specify when it should run, or explicitly say it should be manual.');
}

function buildNormalizedWorkloadPayload(params = {}, context = {}, session = null) {
  const canonical = buildCanonicalWorkloadPayload(params, {
    session,
    recentMessages: context?.recentMessages || [],
    timezone: params.timezone || context?.timezone,
    now: params.now || context?.now,
  });

  return canonical || null;
}

function applyWorkloadExecutionPreferences(payload = {}, params = {}, context = {}) {
  const metadata = payload?.metadata && typeof payload.metadata === 'object'
    ? { ...payload.metadata }
    : {};
  const requestedModel = String(
    metadata.requestedModel
    || params.model
    || context.model
    || '',
  ).trim();

  if (!requestedModel) {
    return payload;
  }

  return {
    ...payload,
    metadata: {
      ...metadata,
      requestedModel,
    },
  };
}

function buildWorkloadWarningSuffix(workload = {}) {
  const warnings = Array.isArray(workload?.metadata?.outputFormatWarnings)
    ? workload.metadata.outputFormatWarnings.filter((warning) => String(warning || '').trim())
    : [];

  if (warnings.length === 0) {
    return '';
  }

  return ` Warning: ${warnings[0]}`;
}

function resolveDocumentService(context = {}) {
  const service = context?.documentService || null;
  if (!service?.recommendDocumentWorkflow
    || !service?.buildDocumentPlan
    || !service?.aiGenerate
    || !service?.assemble
    || !service?.generatePresentation) {
    throw new Error('Document workflows are unavailable because the document service is not initialized.');
  }

  return service;
}

function resolvePodcastService(context = {}) {
  const service = context?.podcastService || podcastService;
  if (!service?.createPodcast) {
    throw new Error('Podcast workflows are unavailable because the podcast service is not initialized.');
  }

  return service;
}

function resolvePodcastVideoService(context = {}) {
  const service = context?.podcastVideoService || podcastVideoService;
  if (!service?.createVideoFromPodcast) {
    throw new Error('Podcast video rendering is unavailable because the podcast video service is not initialized.');
  }

  return service;
}

function buildPodcastVideoOptions(params = {}, context = {}) {
  const nested = params.video && typeof params.video === 'object' && !Array.isArray(params.video)
    ? params.video
    : {};
  const contextModel = String(context?.model || '').trim();
  const resolveBooleanOption = (...values) => {
    for (const value of values) {
      if (typeof value === 'boolean') {
        return value;
      }
    }
    return undefined;
  };
  const resolveNumberOption = (...values) => {
    for (const value of values) {
      if (value != null && value !== '') {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : undefined;
      }
    }
    return undefined;
  };

  return {
    topic: params.topic || params.prompt || params.subject || nested.topic || '',
    aspectRatio: params.videoAspectRatio || params.aspectRatio || nested.aspectRatio || '16:9',
    imageMode: params.videoImageMode || params.imageMode || nested.imageMode || 'generated',
    generateImages: resolveBooleanOption(params.videoGenerateImages, params.generateImages, nested.generateImages),
    enhanceAudio: resolveBooleanOption(params.videoEnhanceAudio, params.enhanceAudio, nested.enhanceAudio),
    visualEffects: resolveBooleanOption(params.videoVisualEffects, params.visualEffects, nested.visualEffects),
    sceneCount: Number(params.videoSceneCount || params.sceneCount || nested.sceneCount) || undefined,
    generatedImageRatio: resolveNumberOption(params.videoGeneratedImageRatio, params.generatedImageRatio, nested.generatedImageRatio),
    renderMode: params.videoRenderMode || params.renderMode || nested.renderMode || undefined,
    visualStyle: params.videoVisualStyle || params.visualStyle || nested.visualStyle || '',
    imageModel: params.videoImageModel || params.imageModel || nested.imageModel || null,
    model: contextModel || params.videoModel || params.model || nested.model || null,
    reasoningEffort: params.videoReasoningEffort || params.reasoningEffort || nested.reasoningEffort || null,
    ffmpegTimeoutMs: Number(params.videoFfmpegTimeoutMs || params.ffmpegTimeoutMs || nested.ffmpegTimeoutMs) || undefined,
    segmentTimeoutMs: Number(params.videoSegmentTimeoutMs || params.segmentTimeoutMs || nested.segmentTimeoutMs) || undefined,
    muxTimeoutMs: Number(params.videoMuxTimeoutMs || params.muxTimeoutMs || nested.muxTimeoutMs) || undefined,
    useModel: nested.useModel === false || params.useModel === false ? false : undefined,
    scenes: Array.isArray(params.scenes) ? params.scenes : Array.isArray(nested.scenes) ? nested.scenes : undefined,
    toolManager: context.toolManager || null,
    toolContext: {
      ...context,
      executionProfile: 'podcast-video',
      clientSurface: 'podcast-video',
      taskType: 'podcast-video',
    },
  };
}

function normalizeDocumentWorkflowAction(value = '') {
  return String(value || '').trim().toLowerCase() || 'recommend';
}

function normalizeDocumentWorkflowFormat(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'doc' || normalized === 'docx' || normalized === 'word') {
    return 'html';
  }
  if (normalized === 'markdown') {
    return 'md';
  }
  if (normalized === 'excel' || normalized === 'spreadsheet' || normalized === 'workbook') {
    return 'xlsx';
  }
  if (normalized === 'powerpoint' || normalized === 'slides' || normalized === 'deck') {
    return 'pptx';
  }
  if (normalized === 'website' || normalized === 'webpage' || normalized === 'web-page') {
    return 'html';
  }
  return normalized;
}

function inferDocumentWorkflowFormatFromText(text = '') {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  if (/\bpdf\b|\.pdf\b/.test(normalized)) {
    return 'pdf';
  }

  if (/\b(?:powerpoint|pptx|ppt|slide deck|slides?|deck)\b/.test(normalized)) {
    return 'pptx';
  }

  if (/\b(?:excel|xlsx|spreadsheet|workbook)\b/.test(normalized)) {
    return 'xlsx';
  }

  if (/\b(?:markdown|md)\b/.test(normalized)) {
    return 'md';
  }

  if (/\b(?:html|web page|webpage|landing page|site page)\b/.test(normalized)) {
    return 'html';
  }

  return '';
}

function normalizeDocumentWorkflowFormats(values = [], fallback = 'html') {
  const rawValues = Array.isArray(values)
    ? values
    : String(values || '').split(',');
  const formats = dedupeStringList(rawValues.map(normalizeDocumentWorkflowFormat))
    .filter(Boolean)
    .slice(0, MAX_DOCUMENT_SUITE_FORMATS);

  return formats.length > 0 ? formats : [normalizeDocumentWorkflowFormat(fallback)];
}

function normalizeDocumentPageTarget(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(numeric), 20);
}

function truncateDocumentSourceText(value = '', limit = MAX_DOCUMENT_SOURCE_CHARS) {
  const text = String(value || '').trim();
  const safeLimit = Math.max(1, Number(limit) || MAX_DOCUMENT_SOURCE_CHARS);
  if (!text || text.length <= safeLimit) {
    return text;
  }

  const marker = `\n[omitted ${text.length - safeLimit} middle chars]\n`;
  const available = Math.max(1, safeLimit - marker.length);
  const headLength = Math.max(1, Math.floor(available * 0.68));
  const tailLength = Math.max(1, available - headLength);
  const omitted = Math.max(0, text.length - headLength - tailLength);

  return [
    text.slice(0, headLength).trimEnd(),
    `\n[omitted ${omitted} middle chars]\n`,
    text.slice(-tailLength).trimStart(),
  ].join('');
}

function normalizeDocumentSources(sources = []) {
  return (Array.isArray(sources) ? sources : [])
    .map((source, index) => {
      if (!source || typeof source !== 'object') {
        return null;
      }

      const content = truncateDocumentSourceText(
        source.content
        || source.text
        || source.body
        || source.summary
        || '',
      );

      if (!content) {
        return null;
      }

      const title = String(source.title || source.heading || source.label || '').trim();
      const sourceLabel = String(source.sourceLabel || source.source || source.site || '').trim();
      const sourceUrl = String(source.sourceUrl || source.url || '').trim();
      const kind = String(source.kind || source.type || '').trim();

      return {
        id: String(source.id || `source-${index + 1}`).trim(),
        title,
        sourceLabel,
        sourceUrl,
        kind,
        content,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_DOCUMENT_SOURCES);
}

function normalizeDocumentWorkflowImages(images = []) {
  return (Array.isArray(images) ? images : [])
    .map((image) => {
      if (!image || typeof image !== 'object') {
        return null;
      }

      const url = String(image.url || image.imageUrl || image.downloadUrl || image.normalizedUrl || '').trim();
      if (!url) {
        return null;
      }

      return {
        url,
        title: normalizeWhitespace(image.title || image.alt || image.prompt || image.caption || 'Document image'),
        alt: normalizeWhitespace(image.alt || image.imageAlt || image.title || image.prompt || 'Document image'),
        source: normalizeWhitespace(image.source || image.sourceKind || image.attribution || ''),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeDocumentWorkflowGraphs(graphs = []) {
  return (Array.isArray(graphs) ? graphs : [])
    .map((graph, index) => {
      if (!graph || typeof graph !== 'object') {
        return null;
      }

      return {
        ...graph,
        id: String(graph.id || graph.name || graph.title || `document-graph-${index + 1}`).trim(),
        title: normalizeWhitespace(graph.title || graph.name || `Document Graph ${index + 1}`),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function buildGraphImageAssetsFromResult(graphResult = null) {
  const images = Array.isArray(graphResult?.images) ? graphResult.images : [];
  return images
    .map((image) => ({
      url: String(image.url || image.downloadUrl || '').trim(),
      title: normalizeWhitespace(image.title || 'Generated diagram'),
      alt: normalizeWhitespace(image.alt || image.title || 'Generated diagram'),
      source: 'graph-diagram',
    }))
    .filter((image) => image.url);
}

function buildGroundedDocumentPrompt(prompt = '', sources = [], preferences = {}) {
  const normalizedPrompt = String(prompt || '').trim();
  const normalizedSources = normalizeDocumentSources(sources);
  const normalizedImages = normalizeDocumentWorkflowImages(preferences.images || []);
  const sections = [];

  if (normalizedPrompt) {
    sections.push(normalizedPrompt);
  }

  const preferenceLines = [
    preferences.title ? `Preferred title: ${String(preferences.title).trim()}` : '',
    preferences.subtitle ? `Preferred subtitle: ${String(preferences.subtitle).trim()}` : '',
    preferences.audience ? `Audience: ${String(preferences.audience).trim()}` : '',
    preferences.style ? `Style: ${String(preferences.style).trim()}` : '',
    preferences.theme ? `Theme: ${String(preferences.theme).trim()}` : '',
    preferences.format ? `Target format: ${String(preferences.format).trim()}` : '',
    preferences.documentType ? `Document type: ${String(preferences.documentType).trim()}` : '',
    preferences.pageTarget ? `Target depth: up to ${String(preferences.pageTarget).trim()} pages of research-aligned content.` : '',
  ].filter(Boolean);

  if (preferenceLines.length > 0) {
    sections.push(preferenceLines.join('\n'));
  }

  if (normalizedSources.length > 0) {
    sections.push([
      'The source URLs were already discovered from verified research results.',
      'Do not ask the user to supply website lists or source URLs unless they explicitly want to constrain the source set.',
      'Use the verified source material below as working facts and source context.',
      'Preserve concrete numbers, names, links, dates, and pricing details unless the source material conflicts.',
      'Do not mention internal tool names, failed tool calls, web-search/web-fetch workflow steps, or source-gathering process notes in the visible document.',
      normalizedSources.map((source, index) => [
        `[Source ${index + 1}] ${source.title || source.sourceLabel || source.kind || source.id}`,
        source.sourceLabel ? `Label: ${source.sourceLabel}` : '',
        source.sourceUrl ? `URL: ${source.sourceUrl}` : '',
        source.kind ? `Kind: ${source.kind}` : '',
        `Content:\n${source.content}`,
      ].filter(Boolean).join('\n')).join('\n\n'),
    ].join('\n\n'));
  }

  if (normalizedImages.length > 0) {
    sections.push([
      '[Verified image references]',
      'Use these real image URLs with imageUrl/imageAlt/imageCaption fields when they improve the document. Do not describe missing images or image-search process.',
      normalizedImages.map((image, index) => [
        `Image ${index + 1}: ${image.title}`,
        `URL: ${image.url}`,
        image.alt ? `Alt: ${image.alt}` : '',
        image.source ? `Source: ${image.source}` : '',
      ].filter(Boolean).join('\n')).join('\n\n'),
    ].join('\n\n'));
  }

  return sections.filter(Boolean).join('\n\n').trim();
}

function isTextualDocumentMimeType(mimeType = '', filename = '') {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  const normalizedFilename = String(filename || '').trim().toLowerCase();

  return normalizedMime.startsWith('text/')
    || normalizedMime.includes('json')
    || normalizedFilename.endsWith('.html')
    || normalizedFilename.endsWith('.htm')
    || normalizedFilename.endsWith('.md')
    || normalizedFilename.endsWith('.markdown');
}

function buildDocumentWorkflowResult(document = null, { includeContent = false } = {}) {
  if (!document) {
    return null;
  }

  const textualContent = isTextualDocumentMimeType(document.mimeType, document.filename)
    ? String(document.contentBuffer || document.content || '')
    : '';

  return {
    id: document.id,
    filename: document.filename,
    mimeType: document.mimeType,
    size: document.size,
    metadata: document.metadata || {},
    preview: document.preview || null,
    downloadUrl: document.downloadUrl || (document.id ? `/api/documents/${document.id}/download` : null),
    ...(textualContent
      ? {
        contentPreview: textualContent.slice(0, 4000),
        ...(includeContent ? { content: textualContent } : {}),
      }
      : {}),
  };
}

function normalizeWorkflowDocumentBuffer(document = null) {
  if (Buffer.isBuffer(document?.contentBuffer)) {
    return document.contentBuffer;
  }

  if (Buffer.isBuffer(document?.content)) {
    return document.content;
  }

  if (typeof document?.content === 'string') {
    return Buffer.from(document.content, 'utf8');
  }

  if (typeof document?.preview?.content === 'string' && document.preview.content.trim()) {
    return Buffer.from(document.preview.content, 'utf8');
  }

  return null;
}

function resolveWorkflowDocumentPreviewHtml(document = null) {
  if (typeof document?.previewHtml === 'string' && document.previewHtml.trim()) {
    return document.previewHtml;
  }

  if (document?.preview?.type === 'html' && typeof document.preview.content === 'string' && document.preview.content.trim()) {
    return document.preview.content;
  }

  if (isTextualDocumentMimeType(document?.mimeType, document?.filename)
    && /\.html?$/i.test(String(document?.filename || ''))
    && typeof document?.content === 'string') {
    return document.content;
  }

  return '';
}

async function persistWorkflowDocumentArtifact(document = null, context = {}, options = {}) {
  if (!document || !context?.sessionId || typeof artifactService?.createStoredArtifact !== 'function') {
    return null;
  }

  const buffer = normalizeWorkflowDocumentBuffer(document);
  if (!buffer) {
    return null;
  }

  const format = normalizeDocumentWorkflowFormat(
    document?.metadata?.format
    || document?.format
    || document?.extension
    || '',
  ) || inferFileWriteArtifactExtension(document?.filename || 'document.html');
  const previewHtml = resolveWorkflowDocumentPreviewHtml(document);
  const extractedText = String(document?.extractedText || '').trim()
    || (previewHtml ? stripHtml(previewHtml) : '')
    || (isTextualDocumentMimeType(document?.mimeType, document?.filename) ? buffer.toString('utf8').slice(0, 12000) : '');
  const hasPiiPlaceholders = /\[\[PII:[^\]\r\n]+?\]\]/.test(previewHtml || extractedText || '');
  if (format === 'pdf'
    && hasPiiPlaceholders
    && previewHtml
    && typeof artifactService.storeGeneratedArtifactFromContent === 'function') {
    return artifactService.storeGeneratedArtifactFromContent({
      sessionId: context.sessionId,
      session: context.session || null,
      mode: context.clientSurface || 'chat',
      format: 'pdf',
      content: previewHtml,
      title: document?.metadata?.title || document?.title || document?.filename || 'document',
      metadata: {
        ...(document?.metadata || {}),
        originalDocumentId: document?.id || null,
        originalDownloadUrl: document?.downloadUrl || null,
        persistedFrom: 'document-workflow',
        rerenderedFromRestoredPiiPlaceholders: true,
        toolId: DOCUMENT_WORKFLOW_TOOL_ID,
      },
      ownerId: context.ownerId || context.userId || null,
    });
  }

  try {
    const stored = await artifactService.createStoredArtifact({
      sessionId: context.sessionId,
      session: context.session || null,
      direction: 'generated',
      sourceMode: context.clientSurface || 'chat',
      filename: document.filename || `document.${format || 'html'}`,
      extension: format || inferFileWriteArtifactExtension(document?.filename || 'document.html'),
      mimeType: document.mimeType || inferFileWriteArtifactMimeType(format || 'html'),
      buffer,
      extractedText,
      previewHtml,
      metadata: {
        ...(document?.metadata || {}),
        originalDocumentId: document?.id || null,
        originalDownloadUrl: document?.downloadUrl || null,
        persistedFrom: 'document-workflow',
        toolId: DOCUMENT_WORKFLOW_TOOL_ID,
      },
      vectorize: Boolean(extractedText),
    });
    const serialized = typeof artifactService.serializeArtifact === 'function'
      ? artifactService.serializeArtifact(stored)
      : null;
    return serialized || null;
  } catch (error) {
    if (options.log !== false) {
      console.warn(`[document-workflow] Failed to persist workflow document artifact: ${error.message}`);
    }
    return null;
  }
}

async function buildPersistedDocumentWorkflowResult(document = null, context = {}, options = {}) {
  const persistedArtifact = await persistWorkflowDocumentArtifact(document, context);
  if (!persistedArtifact) {
    return buildDocumentWorkflowResult(document, options);
  }

  const content = isTextualDocumentMimeType(persistedArtifact.mimeType, persistedArtifact.filename)
    ? String(document?.contentBuffer || document?.content || document?.preview?.content || '')
    : '';

  return {
    id: persistedArtifact.id,
    filename: persistedArtifact.filename,
    mimeType: persistedArtifact.mimeType,
    size: persistedArtifact.sizeBytes || persistedArtifact.size || 0,
    metadata: persistedArtifact.metadata || {},
    preview: persistedArtifact.preview || null,
    downloadUrl: persistedArtifact.downloadUrl || null,
    ...(persistedArtifact.previewUrl ? { previewUrl: persistedArtifact.previewUrl } : {}),
    ...(persistedArtifact.bundleDownloadUrl ? { bundleDownloadUrl: persistedArtifact.bundleDownloadUrl } : {}),
    artifact: persistedArtifact,
    artifacts: [persistedArtifact],
    ...(content
      ? {
        contentPreview: content.slice(0, 4000),
        ...(options.includeContent ? { content } : {}),
      }
      : {}),
  };
}

function buildArtifactWorkflowResult(result = null, { includeContent = false } = {}) {
  const artifact = result?.artifact || null;
  if (!artifact) {
    return null;
  }

  const textualContent = isTextualDocumentMimeType(artifact.mimeType, artifact.filename)
    ? String(result?.outputText || artifact.preview?.content || '')
    : '';
  const rawGenerationText = String(result?.outputText || '').trim();

  return {
    id: artifact.id,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    size: artifact.sizeBytes || 0,
    metadata: artifact.metadata || {},
    preview: artifact.preview || null,
    downloadUrl: artifact.downloadUrl || null,
    ...(artifact.previewUrl ? { previewUrl: artifact.previewUrl } : {}),
    ...(artifact.bundleDownloadUrl ? { bundleDownloadUrl: artifact.bundleDownloadUrl } : {}),
    artifact,
    artifacts: [artifact],
    ...(textualContent
      ? {
        contentPreview: textualContent.slice(0, 4000),
        ...(includeContent ? { content: textualContent } : {}),
      }
      : {}),
    ...(!textualContent && rawGenerationText
      ? {
        contentPreview: rawGenerationText.slice(0, 4000),
        ...(includeContent ? { content: rawGenerationText } : {}),
      }
      : {}),
  };
}

function buildSafeDocumentBundlePath(filename = '', fallback = 'document.html') {
  const normalized = String(filename || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);

  return normalized || fallback;
}

function tryParseDocumentWorkflowJson(value = '') {
  const source = String(value || '').trim();
  if (!source || !/^[{[]/.test(source)) {
    return null;
  }

  try {
    return JSON.parse(source);
  } catch (_error) {
    return null;
  }
}

function resolveWorkflowFrontendBundle(document = null) {
  const metadataBundle = document?.metadata?.bundle || document?.metadata?.siteBundle || null;
  const sourceText = String(document?.content || document?.contentPreview || '').trim();
  const parsed = tryParseDocumentWorkflowJson(sourceText);
  const parsedBundle = parsed?.metadata?.bundle || parsed?.metadata?.siteBundle || parsed?.bundle || parsed?.siteBundle || null;
  const parsedContent = typeof parsed?.content === 'string' ? parsed.content : '';
  const fallbackContent = parsedContent || (/<!doctype html|<html|<main|<body/i.test(sourceText) ? sourceText : '');
  const bundle = metadataBundle?.files ? metadataBundle : parsedBundle;
  if (!bundle) {
    return null;
  }
  const normalized = normalizeFrontendBundle(bundle, fallbackContent);

  if (!normalized.files.length) {
    return null;
  }

  return ensureFrontendBundleStyling(normalized);
}

function normalizeSandboxProjectLanguage(frameworkTarget = '') {
  const normalized = String(frameworkTarget || '').trim().toLowerCase();
  if (['html', 'vite', 'react', 'tailwind'].includes(normalized)) {
    return normalized;
  }
  if (['static', 'vanilla', 'plain', 'html-static'].includes(normalized)) {
    return 'html';
  }
  return 'vite';
}

function isPreviewableFrontendWorkflowRequest(prompt = '') {
  const normalized = String(prompt || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /\b(website|web page|webpage|landing page|homepage|microsite|marketing site|product page|campaign page|frontend|front-end|web app|app mockup|site prototype|site mockup|website mockup|ui mockup|interactive prototype|soundtrack system|browser game|web game|video game|sandboxed game|playable game|game prototype|interactive sandbox|vite preview|vite sandbox|multi step frontend|multi-step frontend)\b/.test(normalized)
    || /\b(3d|three\.?js|webgl|web gpu|webgpu|immersive scene|interactive scene|scene sandbox|shader|particles?|orbit controls?)\b/.test(normalized)
    || isDashboardRequest(normalized);
}

function buildSandboxAgentHandoffPrompt(title = 'Document Suite') {
  return [
    '# Sandbox Build Handoff',
    '',
    `Project: ${title || 'Document Suite'}`,
    '',
    'You are in sandbox build mode. Work inside this project bundle and keep every runtime dependency static-safe for the sandbox preview.',
    '',
    'Build rules:',
    '- Use a Kimi K2.6-style creation loop: lock the user intent, decide what context is known or safely assumed, architect the artifact, build it, critique the rendered result, repair issues, and hand off proof.',
    '- Keep an alignment snapshot in the handoff: user goal, audience, target format, assumptions, open questions, acceptance checks, checks run, and checks still needed.',
    '- Apply the Impressive Frontend Websites standard for site, dashboard, app, landing-page, frontend mockup, browser game, and interactive sandbox work: make the first viewport specific to the product or workflow, not a generic placeholder.',
    '- Establish a compact brief from the task; infer audience, primary actions, content hierarchy, brand mood, and target devices when the user did not spell them out.',
    '- Build the actual usable experience with real controls, states, navigation, data regions, empty/loading/error/disabled treatments, and purposeful interactions where the workflow implies them.',
    '- For games, playable simulations, or multi-step Vite apps, create separate project files and include a real game loop or workflow state machine, input handling, score/progress, pause/restart/reset, responsive sizing, and a visible fallback if canvas/WebGL/module loading fails.',
    '- Use visual assets that reveal the product, place, workflow, audience, or state. Avoid vague decorative gradients, blobs, blurred stock-like backgrounds, and screenshot-only mockups.',
    '- Use relative links for local files such as ./styles.css and ./app.js.',
    '- Keep the preview browser-runnable without npm install or a separate build step. Include Vite handoff files when useful, but do not depend on unresolved bare imports for the saved preview.',
    '- Use explicit readable color tokens for page, panels, text, muted text, borders, links, controls, tables, captions, and overlays.',
    '- Avoid one-note palettes, oversized rounded cards, nested cards, clipped text, horizontal overflow, and controls whose opened dropdown/menu/popover states are unreadable.',
    '- Preserve the requested task, audience, and content hierarchy; choose the visual direction from the task instead of applying a fixed house style.',
    '- Treat the included HTML, CSS, images, and data files as editable source for this sandbox.',
    '- Run a browser/UI check before delivery when a browser is available. Capture or inspect desktop and mobile states, opened menus/dropdowns/dialogs/tooltips where relevant, console errors, broken images, low contrast, overlap, clipping, and nonblank canvas/3D pixels.',
    '- Handoff is not complete until source files, preview URL, artifact IDs, fixed issues, assumptions, and target-medium export notes are explicit.',
    '',
    'Available sandbox browser libraries:',
    buildSandboxBrowserLibraryInstructions(),
  ].join('\n');
}

function hasPreviewableSandboxOutput(files = []) {
  return (Array.isArray(files) ? files : []).some((file) => {
    const filePath = String(file?.path || '').trim().toLowerCase();
    return filePath
      && filePath !== 'index.html'
      && filePath !== 'agent_sandbox_build.md'
      && filePath !== 'agent-sandbox-build.md'
      && filePath !== 'agent_sandbox_build'
      && filePath !== 'agent-sandbox-build'
      && filePath !== 'assets/images.json';
  });
}

async function buildDocumentWorkflowSandbox({
  context = {},
  documents = [],
  title = 'Document Suite',
  prompt = '',
  images = [],
} = {}) {
  const frontendBundles = (Array.isArray(documents) ? documents : [])
    .map((entry) => resolveWorkflowFrontendBundle(entry?.document || null))
    .filter(Boolean);
  if (frontendBundles.length === 1) {
    const bundle = frontendBundles[0];
    const files = [
      ...bundle.files,
      {
        path: 'AGENT_SANDBOX_BUILD.md',
        content: buildSandboxAgentHandoffPrompt(title),
        language: 'markdown',
        purpose: 'Agent-to-agent sandbox build instructions',
      },
    ];
    return executeNestedTool(context, 'code-sandbox', {
      mode: 'project',
      language: normalizeSandboxProjectLanguage(bundle.frameworkTarget),
      projectName: buildSafeDocumentBundlePath(title || prompt || 'frontend-sandbox', 'frontend-sandbox')
        .replace(/\.html$/i, ''),
      entry: bundle.entry || 'index.html',
      files,
    });
  }

  const files = buildDocumentSuiteSandboxFiles(documents, title, images);
  if (!hasPreviewableSandboxOutput(files)) {
    return {
      skipped: true,
      reason: 'No previewable HTML outputs were available for sandbox project mode.',
    };
  }

  return executeNestedTool(context, 'code-sandbox', {
    mode: 'project',
    language: 'vite',
    projectName: buildSafeDocumentBundlePath(title || prompt || 'document-suite', 'document-suite')
      .replace(/\.html$/i, ''),
    entry: 'index.html',
    files,
  });
}

function normalizeSandboxImageAssets(images = []) {
  return (Array.isArray(images) ? images : [])
    .map((image, index) => {
      if (!image || typeof image !== 'object') {
        return null;
      }

      const url = String(image.url || image.imageUrl || '').trim();
      const alt = String(image.alt || image.imageAlt || image.title || `Image ${index + 1}`).trim();
      const rawBase64 = String(image.contentBase64 || image.dataBase64 || '').trim();
      const dataUrl = String(image.dataUrl || image.src || '').trim();
      const dataUrlMatch = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
      const mimeType = String(image.mimeType || image.contentType || dataUrlMatch?.[1] || '').trim();
      const extension = mimeType.includes('png')
        ? 'png'
        : (mimeType.includes('webp') ? 'webp' : (mimeType.includes('gif') ? 'gif' : (mimeType.includes('svg') ? 'svg' : 'jpg')));
      const base64 = rawBase64 || dataUrlMatch?.[2] || '';
      const imageFilename = buildSafeDocumentBundlePath(
        String(image.path || image.filename || `image-${index + 1}.${extension}`).split(/[\\/]/).pop(),
        `image-${index + 1}.${extension}`,
      );
      const path = `assets/${imageFilename}`;

      if (!url && !base64) {
        return null;
      }

      return {
        path,
        url,
        alt,
        title: String(image.title || alt).trim(),
        attribution: String(image.attribution || image.imageSource || image.source || '').trim(),
        mimeType,
        base64,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_VERIFIED_REFERENCE_IMAGES);
}

function buildDocumentSuiteSandboxFiles(documents = [], title = 'Document Suite', images = []) {
  const usedPaths = new Set(['index.html', 'AGENT_SANDBOX_BUILD.md']);
  const reservePath = (candidate = '', fallback = 'document.html') => {
    const normalizedCandidate = normalizeBundlePath(candidate || fallback);
    const normalized = (normalizedCandidate || fallback)
      .split('/')
      .map((segment) => buildSafeDocumentBundlePath(segment, 'file'))
      .filter(Boolean)
      .join('/') || buildSafeDocumentBundlePath(fallback, 'document.html');
    if (!usedPaths.has(normalized)) {
      usedPaths.add(normalized);
      return normalized;
    }

    const extension = normalized.includes('.') ? normalized.replace(/^.*(\.[^.]+)$/i, '$1') : '';
    const base = extension ? normalized.slice(0, -extension.length) : normalized;
    let cursor = 2;
    while (usedPaths.has(`${base}-${cursor}${extension}`)) {
      cursor += 1;
    }
    const nextPath = `${base}-${cursor}${extension}`;
    usedPaths.add(nextPath);
    return nextPath;
  };
  const htmlDocuments = (Array.isArray(documents) ? documents : [])
    .map((entry, index) => ({
      index,
      format: entry?.format || '',
      documentType: entry?.documentType || '',
      document: entry?.document || null,
    }))
    .filter((entry) => (
      entry.document
      && isTextualDocumentMimeType(entry.document.mimeType, entry.document.filename)
      && String(entry.document.content || entry.document.contentPreview || '').trim()
    ));

  const files = htmlDocuments.map((entry) => ({
    path: reservePath(entry.document.filename, `document-${entry.index + 1}.html`),
    content: String(entry.document.content || entry.document.contentPreview || ''),
    language: 'html',
    purpose: `${entry.format || 'document'} output`,
  }));

  (Array.isArray(documents) ? documents : []).forEach((entry, index) => {
    const bundle = resolveWorkflowFrontendBundle(entry?.document || null);
    if (!bundle) {
      return;
    }

    bundle.files.forEach((file) => {
      const normalizedPath = normalizeBundlePath(file.path || '');
      if (!normalizedPath) {
        return;
      }

      files.push({
        path: reservePath(normalizedPath, `bundle-${index + 1}.html`),
        content: file.content || '',
        ...(file.contentBuffer ? { contentBuffer: file.contentBuffer } : {}),
        ...(file.contentBase64 ? { contentBase64: file.contentBase64 } : {}),
        language: file.language || null,
        purpose: file.purpose || `${entry?.format || 'frontend'} sandbox bundle file ${index + 1}`,
      });
    });
  });

  const imageAssets = normalizeSandboxImageAssets(images);
  const imageFiles = imageAssets
    .filter((image) => image.base64)
    .map((image) => ({
      path: image.path,
      contentBase64: image.base64,
      language: null,
      purpose: image.attribution ? `Attached image: ${image.attribution}` : 'Attached image asset',
    }));
  const imageGallery = imageAssets.map((image) => {
    const src = image.base64 ? `./${escapeHtml(image.path)}` : escapeHtml(image.url);
    const caption = [image.title, image.attribution].filter(Boolean).join(' - ');
    return `<figure><img src="${src}" alt="${escapeHtml(image.alt)}"><figcaption>${escapeHtml(caption || image.alt)}</figcaption></figure>`;
  }).join('\n');
  const links = files.map((file, index) => {
    const source = htmlDocuments[index] || {};
    const label = source.document?.filename || file.path;
    return `<li><a href="./${escapeHtml(file.path)}">${escapeHtml(label)}</a><span>${escapeHtml(source.documentType || source.format || 'document')}</span></li>`;
  }).join('\n');

  const indexHtml = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title || 'Document Suite')}</title>`,
    '<style>',
    'body{font-family:Aptos,Segoe UI,sans-serif;margin:0;background:#f7f8fb;color:#111827;}',
    'main{max-width:980px;margin:0 auto;padding:40px 24px;}',
    'h1{font-size:clamp(2rem,5vw,4rem);line-height:1;margin:0 0 12px;}',
    'p{color:#4b5563;line-height:1.65;}',
    'ul{display:grid;gap:12px;list-style:none;padding:0;margin:28px 0;}',
    'li{display:flex;justify-content:space-between;gap:16px;border:1px solid #dde3ee;border-radius:10px;background:white;padding:14px 16px;}',
    'a{color:#0f4c81;font-weight:700;text-decoration:none;}',
    'span{color:#6b7280;font-size:.9rem;}',
    '.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-top:28px;}',
    'figure{margin:0;border:1px solid #dde3ee;border-radius:10px;background:white;padding:10px;}',
    'img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;display:block;}',
    'figcaption{color:#6b7280;font-size:.82rem;line-height:1.35;margin-top:8px;}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(title || 'Document Suite')}</h1>`,
    '<p>Sandbox build bundle assembled from the generated document outputs. Use this index to inspect the HTML and dashboard surfaces together after the document build process.</p>',
    `<ul>${links || '<li><span>No previewable HTML outputs were available.</span></li>'}</ul>`,
    imageGallery ? `<section><h2>Attached Images</h2><div class="gallery">${imageGallery}</div></section>` : '',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');

  return [
    {
      path: 'index.html',
      content: indexHtml,
      language: 'html',
      purpose: 'Suite index',
    },
    {
      path: 'AGENT_SANDBOX_BUILD.md',
      content: buildSandboxAgentHandoffPrompt(title),
      language: 'markdown',
      purpose: 'Agent-to-agent sandbox build instructions',
    },
    ...files,
    ...imageFiles,
    {
      path: 'assets/images.json',
      content: JSON.stringify(imageAssets.map(({ base64, ...image }) => ({
        ...image,
        attached: Boolean(base64),
      })), null, 2),
      language: 'json',
      purpose: 'Image attachment manifest',
    },
  ];
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizePositiveInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  const normalized = Math.floor(numeric);
  if (!Number.isFinite(maximum) || maximum <= 0) {
    return normalized;
  }

  return Math.min(normalized, maximum);
}

function dedupeStringList(values = []) {
  const seen = new Set();
  const results = [];

  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(normalized);
  }

  return results;
}

function normalizeSourceText(value = '') {
  return truncateDocumentSourceText(normalizeWhitespace(stripHtml(String(value || ''))));
}

function normalizeDeepResearchImage(image = {}) {
  if (!image || typeof image !== 'object') {
    return null;
  }

  const url = String(image.url || image.imageUrl || '').trim();
  if (!url) {
    return null;
  }

  return {
    url,
    alt: String(image.alt || image.imageAlt || deriveImageAltText(url, 'image')).trim() || 'image',
    title: String(image.title || '').trim(),
    host: String(image.host || image.source || '').trim(),
    mimeType: String(image.mimeType || '').trim() || null,
    author: String(image.author || '').trim(),
    authorLink: String(image.authorLink || '').trim(),
    attribution: String(image.attribution || '').trim(),
    verified: image.verified === true,
    verificationMethod: String(image.verificationMethod || '').trim() || null,
    source: String(image.sourceKind || image.sourceType || image.source || '').trim() || 'image',
  };
}

function hasDeepResearchPresentationIntent(prompt = '') {
  const normalized = String(prompt || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const hasResearchIntent = /\b(deep research|research|look up|search the web|browse the web|search online|browse online|latest|current|today|news)\b/.test(normalized);
  const hasPresentationIntent = /\b(slides|presentation|slide deck|deck|pptx|website slides)\b/.test(normalized);
  return hasResearchIntent && hasPresentationIntent;
}

function deriveDeepResearchQueries({
  prompt = '',
  plan = null,
  researchQueries = [],
  passCount = DEFAULT_DEEP_RESEARCH_PASSES,
} = {}) {
  const outlineQueries = Array.isArray(plan?.outline)
    ? plan.outline
      .map((item) => item?.title || item?.heading || '')
      .filter((value) => value && !/^title slide$/i.test(String(value)))
      .slice(0, Math.max(0, passCount - 1))
      .map((label) => `${prompt} ${label}`.trim())
    : [];

  return dedupeStringList([
    ...researchQueries,
    prompt,
    plan?.titleSuggestion ? `${prompt} ${plan.titleSuggestion}` : '',
    ...outlineQueries,
  ]).slice(0, passCount);
}

function summarizeDeepResearchSourceForMemory(source = {}) {
  const content = String(source?.content || '').trim();
  if (!content) {
    return '';
  }

  const limit = Math.max(300, Math.min(Number(config.memory?.researchSourceExcerptChars || 4000), MAX_DOCUMENT_SOURCE_CHARS));
  return content.length > limit ? `${content.slice(0, limit)}...` : content;
}

async function storeDeepResearchSourcesInMemory({
  context = {},
  prompt = '',
  query = '',
  passIndex = 0,
  sources = [],
} = {}) {
  if (!context?.memoryService?.rememberResearchNote || !context?.sessionId) {
    return [];
  }

  const writes = (Array.isArray(sources) ? sources : [])
    .filter((source) => source && typeof source === 'object' && (source.sourceUrl || source.title || source.content))
    .slice(0, DEFAULT_DEEP_RESEARCH_PAGES_PER_PASS)
    .map((source) => {
      const note = [
        '[Research note]',
        prompt ? `Objective: ${prompt}` : null,
        query ? `Query: ${query}` : null,
        `Pass: ${passIndex + 1}`,
        source.title ? `Title: ${String(source.title).trim()}` : null,
        source.sourceUrl ? `URL: ${String(source.sourceUrl).trim()}` : null,
        source.sourceLabel ? `Source: ${String(source.sourceLabel).trim()}` : null,
        `Source notes: ${summarizeDeepResearchSourceForMemory(source)}`,
      ].filter(Boolean).join('\n');

      return context.memoryService.rememberResearchNote(context.sessionId, note, {
        ...(context.ownerId ? { ownerId: context.ownerId } : {}),
        ...(context.memoryScope ? { memoryScope: context.memoryScope } : {}),
        ...(context.sourceSurface ? { sourceSurface: context.sourceSurface } : {}),
        ...(context.projectKey ? { projectKey: context.projectKey } : {}),
        sourceUrl: String(source.sourceUrl || '').trim(),
        sourceTitle: String(source.title || '').trim(),
        summary: String(source.title || source.sourceLabel || query || prompt || '').trim(),
        memoryKeywords: mergeMemoryKeywords([
          prompt,
          query,
          source.title,
          source.sourceLabel,
          source.kind,
        ].filter(Boolean), source.content || '', 20),
      });
    });

  if (writes.length === 0) {
    return [];
  }

  return Promise.allSettled(writes);
}

async function deriveDeepResearchProgressKeywords({
  context = {},
  prompt = '',
  query = '',
  sources = [],
} = {}) {
  const sourceKeywordSeed = normalizeMemoryKeywords(
    (Array.isArray(sources) ? sources : []).flatMap((source) => mergeMemoryKeywords([
      prompt,
      query,
      source?.title || '',
      source?.sourceLabel || '',
      source?.kind || '',
    ], source?.content || '', 12)),
    24,
  );

  if ((!context?.memoryService?.recallDetailed && !context?.memoryService?.recall) || !context?.sessionId) {
    return sourceKeywordSeed.slice(0, MAX_DEEP_RESEARCH_QUERY_KEYWORDS);
  }

  try {
    const recall = context.memoryService.recallDetailed
      ? await context.memoryService.recallDetailed(prompt || query, {
        sessionId: context.sessionId,
        ...(context.ownerId ? { ownerId: context.ownerId } : {}),
        ...(context.memoryScope ? { memoryScope: context.memoryScope } : {}),
        ...(context.sourceSurface ? { sourceSurface: context.sourceSurface } : {}),
        ...(context.projectKey ? { projectKey: context.projectKey } : {}),
        profile: 'research',
        objective: prompt || query,
        memoryKeywords: sourceKeywordSeed,
        topK: DEFAULT_DEEP_RESEARCH_RECALL_TOP_K,
      })
      : { entries: [] };

    const recallEntries = Array.isArray(recall?.entries) ? recall.entries : [];
    const recallKeywords = normalizeMemoryKeywords([
      ...recallEntries.flatMap((entry) => entry?.metadata?.keywords || []),
      ...recallEntries.flatMap((entry) => entry?.keywordOverlap || []),
      ...recallEntries.map((entry) => entry?.text || ''),
    ], 24);

    return normalizeMemoryKeywords([
      ...recallKeywords,
      ...sourceKeywordSeed,
    ], MAX_DEEP_RESEARCH_QUERY_KEYWORDS);
  } catch (_error) {
    return sourceKeywordSeed.slice(0, MAX_DEEP_RESEARCH_QUERY_KEYWORDS);
  }
}

function buildRefinedDeepResearchQuery({
  baseQuery = '',
  prompt = '',
  progressKeywords = [],
} = {}) {
  const normalizedBaseQuery = String(baseQuery || prompt || '').trim();
  if (!normalizedBaseQuery) {
    return '';
  }

  const loweredBaseQuery = normalizedBaseQuery.toLowerCase();
  const appendedKeywords = normalizeMemoryKeywords(progressKeywords, MAX_DEEP_RESEARCH_QUERY_KEYWORDS)
    .filter((keyword) => (
      keyword
      && keyword.length >= 3
      && !/^https?:/i.test(keyword)
      && !loweredBaseQuery.includes(keyword.toLowerCase())
    ))
    .slice(0, MAX_DEEP_RESEARCH_QUERY_KEYWORDS);

  return appendedKeywords.length > 0
    ? `${normalizedBaseQuery} ${appendedKeywords.join(' ')}`.trim()
    : normalizedBaseQuery;
}

function buildDeepResearchSourceFromFetch({
  fetched = {},
  searchResult = null,
  fallbackUrl = '',
  kind = 'web-fetch',
} = {}) {
  const url = String(fetched?.url || fallbackUrl || '').trim();
  const title = String(
    fetched?.title
    || searchResult?.title
    || url
    || 'Research source',
  ).trim();
  const sourceLabel = String(searchResult?.source || '').trim();
  const rawText = kind === 'web-scrape'
    ? (
      fetched?.summary
      || fetched?.text
      || fetched?.content
      || JSON.stringify(fetched?.data || {})
    )
    : (
      fetched?.body
      || fetched?.content
      || fetched?.text
      || ''
    );
  const content = normalizeSourceText(rawText);

  if (!content) {
    return null;
  }

  return {
    id: `${kind}-${url || title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    title,
    sourceLabel,
    sourceUrl: url,
    kind,
    content,
  };
}

function buildPresentationResearchPrompt({
  prompt = '',
  sources = [],
  recommendation = null,
  plan = null,
  params = {},
  format = 'pptx',
} = {}) {
  return buildGroundedDocumentPrompt(prompt, sources, {
    title: params.title || plan?.titleSuggestion || '',
    subtitle: params.subtitle || '',
    audience: params.audience || '',
    style: params.style || '',
    theme: params.theme || plan?.themeSuggestion || '',
    format,
    documentType: params.documentType || recommendation?.inferredType || 'presentation',
    pageTarget: normalizeDocumentPageTarget(params.pageTarget || params.maxPages || params.pages, null),
  });
}

function derivePresentationImageQueries({
  prompt = '',
  presentation = {},
  maxImages = DEFAULT_DEEP_RESEARCH_IMAGE_LIMIT,
} = {}) {
  const slides = Array.isArray(presentation?.slides) ? presentation.slides : [];
  const preferredSlides = slides
    .filter((slide) => slide && typeof slide === 'object' && (slide.layout === 'image' || slide.imagePrompt))
    .slice(0, maxImages);

  if (preferredSlides.length === 0) {
    return [];
  }

  return preferredSlides.map((slide, index) => ({
    slideIndex: slides.indexOf(slide),
    query: String(slide.imagePrompt || `${prompt} ${slide.title || `slide ${index + 1}`}`).trim(),
    title: String(slide.title || `Slide ${index + 1}`).trim(),
    caption: String(slide.caption || '').trim(),
  }));
}

function applyImagesToPresentation(presentation = {}, imagesBySlide = new Map()) {
  const slides = Array.isArray(presentation?.slides) ? presentation.slides : [];

  return {
    ...presentation,
    slides: slides.map((slide, index) => {
      const image = normalizeDeepResearchImage(imagesBySlide.get(index));
      if (!image) {
        return slide;
      }

      const attribution = image.attribution
        || (image.author ? `${image.author}${image.authorLink ? ' / Unsplash' : ''}` : image.host);

      return {
        ...slide,
        imageUrl: image.url,
        imageAlt: image.alt || slide.title || `Slide ${index + 1}`,
        imageSource: attribution || '',
        caption: slide.caption || (attribution ? `Image source: ${attribution}` : ''),
      };
    }),
  };
}

async function executeNestedTool(context = {}, toolId = '', params = {}) {
  const toolManager = context?.toolManager || null;
  if (!toolManager?.executeTool) {
    throw new Error(`${toolId} requires a nested tool manager in the execution context.`);
  }

  const nestedContext = context?.toolManager
    ? context
    : { ...context, toolManager };
  const result = await toolManager.executeTool(toolId, params, nestedContext);
  if (!result?.success) {
    throw new Error(result?.error || `${toolId} failed.`);
  }

  return result.data;
}

class ToolManager {
  constructor() {
    this.registry = getUnifiedRegistry();
    this.agentBus = getAgentBus();
    this.loadedTools = new Map();
    this.initialized = false;
  }

  /**
   * Initialize all tools
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    console.log('[ToolManager] Initializing tools...');

    // Register web tools
    this.registerWebTools();
    
    // Register SSH tools
    this.registerSSHTools();
    
    // Register design tools
    this.registerDesignTools();
    
    // Register database tools
    this.registerDatabaseTools();
    
    // Register sandbox tools
    this.registerSandboxTools();
    
    // Register system tools
    this.registerSystemTools();

    // Set up event listeners
    this.setupEventListeners();
    this.refreshToolReadiness();

    this.initialized = true;
    
    console.log(`[ToolManager] Initialized ${this.registry.getAllTools().length} tools`);
    
    return this;
  }

  /**
   * Register web scraping tools
   */
  registerWebTools() {
    try {
      const tools = registerWebTools();
      tools.forEach(tool => {
        this.loadedTools.set(tool.id, tool);
      });
      console.log('[ToolManager] Web tools registered');
    } catch (error) {
      console.error('[ToolManager] Failed to register web tools:', error.message);
    }
  }

  /**
   * Register SSH/remote tools
   */
  registerSSHTools() {
    try {
      const tools = [
        new SSHExecuteTool(),
        new SSHExecuteTool({
          id: 'remote-command',
          name: 'Remote Command',
          description: 'Execute remote server commands through the remote CLI runner when available, falling back to SSH',
        }),
        new RemoteWorkbenchTool(),
        new DockerExecTool(),
        new K3sDeployTool(),
        new RemoteCliAgentTool(),
      ];

      tools.forEach(tool => {
        const definition = this.createToolDefinition(tool, {
          frontend: {
            exposeToFrontend: tool.id !== 'ssh-execute',
            icon: 'terminal',
            requiresSetup: true // SSH needs key configuration
          },
          skill: {
            triggerPatterns: this.getSSHTriggerPatterns(tool.id),
            requiresConfirmation: true
          }
        });
        
        this.registry.register(definition);
        this.loadedTools.set(tool.id, tool);
      });

      console.log('[ToolManager] SSH tools registered');
    } catch (error) {
      console.error('[ToolManager] Failed to register SSH tools:', error.message);
    }
  }

  /**
   * Register design tools
   */
  registerDesignTools() {
    try {
      const tools = registerDesignTools();
      tools.forEach(tool => {
        this.loadedTools.set(tool.id, tool);
      });
      console.log('[ToolManager] Design tools registered');
    } catch (error) {
      console.error('[ToolManager] Failed to register design tools:', error.message);
    }
  }

  /**
   * Register database tools
   */
  registerDatabaseTools() {
    try {
      const tools = registerDatabaseTools();
      tools.forEach(tool => {
        this.loadedTools.set(tool.id, tool);
      });
      console.log('[ToolManager] Database tools registered');
    } catch (error) {
      console.error('[ToolManager] Failed to register database tools:', error.message);
    }
  }

  /**
   * Register sandbox tools
   */
  registerSandboxTools() {
    try {
      const tools = registerSandboxTools();
      tools.forEach(tool => {
        this.loadedTools.set(tool.id, tool);
      });
      console.log('[ToolManager] Sandbox tools registered');
    } catch (error) {
      console.error('[ToolManager] Failed to register sandbox tools:', error.message);
    }
  }

  /**
   * Register system tools
   */
  registerSystemTools() {
    // File system tools
    const fileTools = [
      {
        id: 'file-read',
        name: 'File Reader',
        category: 'system',
        description: 'Read file contents',
        backend: {
          handler: async (params) => {
            const fs = require('fs').promises;
            const content = await fs.readFile(params.path, 'utf8');
            return { content, path: params.path };
          },
          sideEffects: ['read'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            encoding: { type: 'string', default: 'utf8' }
          }
        }
      },
      {
        id: 'file-write',
        name: 'File Writer',
        category: 'system',
        description: 'Write a full content string to a local runtime file. Requires both path and content in the same call. When a session is active, the written file is also mirrored into a downloadable artifact.',
        backend: {
          handler: async (params, context = {}) => {
            const path = require('path');
            const fs = require('fs').promises;
            const normalized = normalizeFileWriteParams(params);

            if (typeof normalized.path !== 'string' || !normalized.path.trim()) {
              throw new Error('file-write requires a non-empty `path` string.');
            }

            if (!Object.prototype.hasOwnProperty.call(normalized, 'content')) {
              throw new Error('file-write requires a `content` string. Provide the full file body in `content`; a path alone is not enough.');
            }

            if (typeof normalized.content !== 'string') {
              throw new Error('file-write `content` must be a string.');
            }

            const targetPath = path.resolve(normalized.path);
            let persistedArtifact = null;

            if (context.sessionId) {
              persistedArtifact = await persistFileWriteArtifact({
                sessionId: context.sessionId,
                sourceMode: resolveArtifactSourceMode(context),
                targetPath,
                content: normalized.content,
              });
            }

            try {
              await fs.mkdir(path.dirname(targetPath), { recursive: true });
              await fs.writeFile(targetPath, normalized.content, normalized.encoding || 'utf8');
            } catch (error) {
              if (persistedArtifact?.id && typeof artifactService.deleteArtifact === 'function') {
                try {
                  await artifactService.deleteArtifact(persistedArtifact.id);
                } catch (cleanupError) {
                  console.warn('[ToolManager] Failed to clean up persisted artifact after file-write error:', cleanupError.message);
                }
              }
              throw error;
            }

            let indexedAsset = null;
            try {
              indexedAsset = await assetManager.upsertWorkspacePath(targetPath, {
                sessionId: context.sessionId || null,
                ownerId: context.ownerId || context.userId || null,
              });
            } catch (error) {
              console.warn('[ToolManager] Failed to index written asset:', error.message);
            }
            return {
              path: targetPath,
              bytesWritten: Buffer.byteLength(normalized.content, normalized.encoding || 'utf8'),
              assetIndexed: Boolean(indexedAsset),
              artifactPersisted: Boolean(persistedArtifact),
              ...(persistedArtifact
                ? {
                  artifact: persistedArtifact,
                  artifacts: [persistedArtifact],
                }
                : {}),
            };
          },
          sideEffects: ['write'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: {
              type: 'string',
              description: 'Local file path in this runtime. For remote hosts or deployed servers, use remote-command or k3s-deploy instead.'
            },
            content: {
              type: 'string',
              description: 'Full file contents to write in this same call.'
            },
            encoding: {
              type: 'string',
              default: 'utf8'
            }
          }
        }
      },
      {
        id: 'asset-search',
        name: 'Asset Search',
        category: 'system',
        description: 'Search the indexed asset catalog for previous images, documents, uploaded artifacts, and workspace files.',
        backend: {
          handler: async (params = {}, context = {}) => assetManager.searchAssets(params, {
            ownerId: context.ownerId || context.userId || null,
            sessionId: context.sessionId || null,
            sessionIsolation: context.sessionIsolation === true,
          }),
          sideEffects: ['read'],
          timeout: 30000
        },
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keywords, filenames, or remembered phrases to match. Leave blank to list recent assets.'
            },
            kind: {
              type: 'string',
              enum: ['any', 'image', 'document'],
              default: 'any'
            },
            sourceType: {
              type: 'string',
              enum: ['any', 'artifact', 'workspace', 'research-bucket'],
              default: 'any'
            },
            sessionId: {
              type: 'string',
              description: 'Optional session id to narrow artifact matches.'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              default: 10
            },
            includeContent: {
              type: 'boolean',
              description: 'Include stored text previews for document-like matches when available.'
            },
            refresh: {
              type: 'boolean',
              description: 'Refresh the asset index before searching when a very recent file is missing.'
            }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'find earlier image',
            'find previous document',
            'search uploaded file',
            'search assets',
            'asset manager',
            'find that pdf from before'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'folder-search'
        }
      },
      {
        id: RELATIONSHIP_CALCULATION_TOOL_ID,
        name: 'PII Relationship Calculator',
        category: 'system',
        description: 'Trusted privacy calculator for grouping, joining, summing, ranking, and filtering placeholder-safe spreadsheet tables without exposing raw PII to the model.',
        backend: {
          handler: async (params = {}, context = {}) => calculateRelationshipWithRepair(params, context),
          sideEffects: ['read'],
          timeout: 15000,
        },
        inputSchema: RELATIONSHIP_CALCULATION_SCHEMA,
        skill: {
          triggerPatterns: [
            'pii relationship calculate',
            'privacy aware spreadsheet calculation',
            'spreadsheet pii totals',
            'group placeholders',
          ],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'calculator',
        },
      },
      {
        id: 'research-bucket-list',
        name: 'Research Bucket List',
        category: 'system',
        description: 'List files in the shared durable research bucket by category, tag, or query without loading full contents.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.researchBucketService || researchBucketService;
            return service.list(params);
          },
          sideEffects: ['read'],
          timeout: 30000
        },
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['images', 'data', 'graphs', 'code', 'audio', 'docs', 'notes', 'refs'] },
            query: { type: 'string' },
            tags: {
              type: 'array',
              items: { type: 'string' }
            },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'research bucket',
            'reference bucket',
            'source library',
            'saved research',
            'project references'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'library'
        }
      },
      {
        id: 'research-bucket-search',
        name: 'Research Bucket Search',
        category: 'system',
        description: 'Search the shared durable research bucket with grep-style text matching over supported text files and manifest metadata.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.researchBucketService || researchBucketService;
            return service.search(params);
          },
          sideEffects: ['read'],
          timeout: 30000
        },
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            category: { type: 'string', enum: ['images', 'data', 'graphs', 'code', 'audio', 'docs', 'notes', 'refs'] },
            glob: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            includeSnippets: { type: 'boolean', default: true }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'search research bucket',
            'grep research bucket',
            'search saved research',
            'find in source library'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'search'
        }
      },
      {
        id: 'research-bucket-read',
        name: 'Research Bucket Read',
        category: 'system',
        description: 'Read selected content or metadata from a file in the shared durable research bucket.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.researchBucketService || researchBucketService;
            return service.read(params);
          },
          sideEffects: ['read'],
          timeout: 30000
        },
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            mode: { type: 'string', enum: ['preview', 'content', 'base64'], default: 'preview' },
            maxBytes: { type: 'integer', minimum: 1, maximum: 1048576, default: 65536 }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'read research bucket',
            'open research bucket',
            'read reference bucket',
            'use bucket file'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'file-text'
        }
      },
      {
        id: 'research-bucket-write',
        name: 'Research Bucket Write',
        category: 'system',
        description: 'Create or update a text or base64 binary file in the shared durable research bucket.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.researchBucketService || researchBucketService;
            const result = await service.write(params);
            let indexedAsset = null;
            try {
              indexedAsset = await assetManager.upsertWorkspacePath(result.absolutePath, {
                sourceType: 'research-bucket',
                sessionId: context.sessionId || null,
                ownerId: context.ownerId || context.userId || null,
              });
            } catch (error) {
              console.warn('[ToolManager] Failed to index research bucket file:', error.message);
            }
            return {
              ...result,
              assetIndexed: Boolean(indexedAsset),
              indexedAsset,
            };
          },
          sideEffects: ['write'],
          timeout: 30000
        },
        inputSchema: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
            category: { type: 'string', enum: ['images', 'data', 'graphs', 'code', 'audio', 'docs', 'notes', 'refs'] },
            mimeType: { type: 'string' },
            tags: {
              type: 'array',
              items: { type: 'string' }
            },
            description: { type: 'string' }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'write research bucket',
            'save to research bucket',
            'add to research bucket',
            'store in reference bucket'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'archive'
        }
      },
      {
        id: 'research-bucket-mkdir',
        name: 'Research Bucket Directory Creator',
        category: 'system',
        description: 'Create a safe subfolder inside the shared durable research bucket.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.researchBucketService || researchBucketService;
            return service.mkdir(params);
          },
          sideEffects: ['write'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'create research bucket folder',
            'make research bucket directory',
            'research bucket mkdir'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'folder-plus'
        }
      },
      {
        id: 'public-source-list',
        name: 'Public Source Index List',
        category: 'web',
        description: 'List indexed public APIs, dashboards, news feeds, data portals, RSS feeds, and other public information sources.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.publicSourceIndexService || publicSourceIndexService;
            return service.list(params);
          },
          sideEffects: ['read'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: SOURCE_KINDS },
            domain: { type: 'string' },
            status: { type: 'string', enum: STATUSES },
            topics: {
              type: 'array',
              items: { type: 'string' }
            },
            tags: {
              type: 'array',
              items: { type: 'string' }
            },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'public source index',
            'public api index',
            'dashboard source catalog',
            'news feed catalog',
            'data feed index',
            'api source library'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'radio'
        }
      },
      {
        id: 'public-source-search',
        name: 'Public Source Index Search',
        category: 'web',
        description: 'Search the durable index of public APIs, dashboards, news feeds, RSS feeds, data portals, and public data endpoints.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.publicSourceIndexService || publicSourceIndexService;
            return service.search(params);
          },
          sideEffects: ['read'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            kind: { type: 'string', enum: SOURCE_KINDS },
            domain: { type: 'string' },
            status: { type: 'string', enum: STATUSES },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'search public source index',
            'find public api',
            'find dashboard endpoint',
            'find news feed',
            'lookup public data source',
            'search api source library'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'search'
        }
      },
      {
        id: 'public-source-get',
        name: 'Public Source Index Entry Reader',
        category: 'web',
        description: 'Read one indexed public source entry with endpoint, auth, freshness, format, and verification metadata.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.publicSourceIndexService || publicSourceIndexService;
            return service.get(params);
          },
          sideEffects: ['read'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'read public source',
            'open public source index entry',
            'public api details',
            'source endpoint details'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'file-search'
        }
      },
      {
        id: 'public-source-add',
        name: 'Public Source Index Add',
        category: 'web',
        description: 'Create or update a structured catalog entry for a public API, dashboard, feed, data portal, download, or public web source.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.publicSourceIndexService || publicSourceIndexService;
            return service.upsert(params);
          },
          sideEffects: ['write'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            kind: { type: 'string', enum: SOURCE_KINDS },
            url: { type: 'string' },
            domain: { type: 'string' },
            description: { type: 'string' },
            topics: { type: 'array', items: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
            formats: { type: 'array', items: { type: 'string' } },
            endpoints: { type: 'array', items: { type: 'object' } },
            auth: { type: 'object' },
            rateLimit: { type: 'string' },
            freshness: { type: 'string' },
            termsUrl: { type: 'string' },
            docsUrl: { type: 'string' },
            sourceUrls: { type: 'array', items: { type: 'string' } },
            examples: { type: 'array', items: { type: 'object' } },
            notes: { type: 'string' },
            status: { type: 'string', enum: STATUSES }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'add public source',
            'index public api',
            'save public api endpoint',
            'catalog dashboard source',
            'store news feed source',
            'add data feed'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'bookmark-plus'
        }
      },
      {
        id: 'public-source-refresh',
        name: 'Public Source Index Refresh',
        category: 'web',
        description: 'Verify an indexed public source URL and update status, HTTP, content type, format, and freshness metadata.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = context.publicSourceIndexService || publicSourceIndexService;
            return service.refresh(params);
          },
          sideEffects: ['network', 'write'],
          timeout: 20000
        },
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            url: { type: 'string' }
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'refresh public source',
            'verify public api source',
            'check public feed',
            'validate dashboard endpoint',
            'refresh source index'
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'refresh-cw'
        }
      },
      {
        id: 'agent-notes-write',
        name: 'Agent Notes Writer',
        category: 'system',
        description: 'Update the persistent carryover notes file used for durable project context, Phil preferences, personal-agent memory, and future-useful ideas.',
        backend: {
          handler: async (params) => {
            if (!Object.prototype.hasOwnProperty.call(params || {}, 'content')) {
              throw new Error('agent-notes-write requires a `content` string.');
            }
            if (typeof params.content !== 'string') {
              throw new Error('agent-notes-write `content` must be a string.');
            }
            const content = params.content;
            const saved = writeAgentNotesFile(content);
            return {
              path: saved.absoluteFilePath,
              filePath: saved.filePath,
              characters: saved.characterCount,
              characterLimit: saved.characterLimit,
              updatedAt: saved.updatedAt,
            };
          },
          sideEffects: ['write'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          required: ['content'],
          properties: {
            content: {
              type: 'string',
              description: `Full carryover notes file content. Rewrite the whole file compactly and keep it under ${AGENT_NOTES_CHAR_LIMIT} characters.`
            },
            reason: {
              type: 'string',
              description: 'Short explanation of why this durable note update matters for future sessions.'
            }
          }
        }
      },
      {
        id: 'file-search',
        name: 'File Search',
        category: 'system',
        description: 'Search for files by pattern',
        backend: {
          handler: async (params) => {
            const { glob } = require('glob');
            const files = await glob(params.pattern, { cwd: params.cwd });
            return { files, pattern: params.pattern };
          },
          sideEffects: ['read'],
          timeout: 30000
        },
        inputSchema: {
          type: 'object',
          required: ['pattern'],
          properties: {
            pattern: { type: 'string' },
            cwd: { type: 'string' }
          }
        }
      },
      {
        id: 'file-mkdir',
        name: 'Directory Creator',
        category: 'system',
        description: 'Create a folder or directory',
        backend: {
          handler: async (params) => {
            const path = require('path');
            const fs = require('fs').promises;
            const targetPath = path.resolve(params.path);
            await fs.mkdir(targetPath, { recursive: params.recursive !== false });
            return { path: targetPath, created: true };
          },
          sideEffects: ['write'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            recursive: { type: 'boolean', default: true }
          }
        },
        skill: {
          triggerPatterns: ['create folder', 'create directory', 'make folder', 'make directory', 'mkdir'],
          requiresConfirmation: false
        }
      }
    ];

    // Code execution tools
    const codeTools = [
      {
        id: 'code-execute',
        name: 'Code Executor',
        category: 'system',
        description: 'Execute code in sandboxed environment',
        backend: {
          handler: async (params) => {
            // Would use sandboxed execution
            return { 
              note: 'Sandboxed execution not implemented',
              language: params.language,
              code: params.code.substring(0, 100) + '...'
            };
          },
          sideEffects: ['execute'],
          sandbox: { network: false, filesystem: 'readonly' },
          timeout: 30000
        },
        inputSchema: {
          type: 'object',
          required: ['language', 'code'],
          properties: {
            language: { 
              type: 'string',
              enum: ['javascript', 'python', 'bash', 'sql']
            },
            code: { type: 'string' },
            timeout: { type: 'integer', default: 30000 }
          }
        },
        skill: {
          triggerPatterns: ['run code', 'execute', 'run script', 'test code'],
          requiresConfirmation: true
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'code',
          uiComponent: 'CodeExecutorPanel'
        }
      }
    ];

    const docsTools = [
      {
        id: 'tool-doc-read',
        name: 'Tool Doc Reader',
        category: 'system',
        description: 'Load detailed tool documentation only when explicitly requested',
        backend: {
          handler: async (params) => {
            const metadata = await getToolDocMetadata(params.toolId);
            if (!metadata.docAvailable) {
              throw new Error(`No documentation found for tool '${params.toolId}'`);
            }

            const doc = await readToolDoc(params.toolId);
            return {
              toolId: params.toolId,
              support: metadata.support,
              content: doc.content,
            };
          },
          sideEffects: ['read'],
          timeout: 10000
        },
        inputSchema: {
          type: 'object',
          required: ['toolId'],
          properties: {
            toolId: { type: 'string', description: 'Tool ID to load documentation for' }
          }
        },
        skill: {
          triggerPatterns: ['tool help', 'tool documentation', 'how do i use tool', 'what can this tool do'],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'book-open'
        }
      },
      {
        id: DOCUMENT_WORKFLOW_TOOL_ID,
        name: 'Document Workflow',
        category: 'system',
        description: 'Recommend, plan, and generate documents, slide decks, training/manual packages, and multi-format document suites, optionally grounded in verified research and scrape results.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const documentService = resolveDocumentService(context);
            const action = normalizeDocumentWorkflowAction(params.action);
            const prompt = String(params.prompt || params.request || params.topic || '').trim();
            const documentType = String(params.documentType || params.document_type || '').trim();
            const tone = String(params.tone || 'professional').trim() || 'professional';
            const length = String(params.length || 'medium').trim() || 'medium';
            const promptFormatPreference = inferDocumentWorkflowFormatFromText([
              params.prompt,
              params.request,
              params.topic,
              params.title,
              params.documentType,
            ].filter(Boolean).join('\n'));
            const explicitFormat = String(params.format || '').trim();
            const formatPreference = explicitFormat
              ? normalizeDocumentWorkflowFormat(explicitFormat)
              : promptFormatPreference;
            const requestedFormats = normalizeDocumentWorkflowFormats(
              params.formats || params.outputFormats || [],
              formatPreference || 'html',
            );
            const buildMode = String(params.buildMode || '').trim().toLowerCase();
            const useSandboxBuild = params.useSandbox === true || ['sandbox', 'scripted', 'code'].includes(buildMode);
            const pageTarget = normalizeDocumentPageTarget(params.pageTarget || params.maxPages || params.pages, null);
            const sources = normalizeDocumentSources(params.sources || []);
            const rawImageAssets = [
              ...(Array.isArray(params.images) ? params.images : []),
              ...(Array.isArray(params.imageAssets) ? params.imageAssets : []),
              ...(Array.isArray(params.assets) ? params.assets : []),
            ];
            let imageAssets = normalizeDocumentWorkflowImages(rawImageAssets);
            const graphSpecs = normalizeDocumentWorkflowGraphs(params.graphs || params.graphAssets || params.diagrams || []);
            const limit = Number.isFinite(Number(params.limit))
              ? Math.max(1, Math.min(Number(params.limit), 8))
              : 4;
            const recommendation = documentService.recommendDocumentWorkflow({
              prompt,
              documentType,
              format: formatPreference,
              limit,
            });
            const resolvedDocumentType = documentType || recommendation.inferredType || 'document';
            const resolvedFormat = formatPreference || recommendation.recommendedFormat || 'html';

            if (action === 'recommend') {
              return {
                action,
                recommendation,
                sourceCount: sources.length,
              };
            }

            if (action === 'plan') {
              return {
                action,
                plan: documentService.buildDocumentPlan({
                  prompt: buildGroundedDocumentPrompt(prompt, sources, {
                    title: params.title,
                    subtitle: params.subtitle,
                    audience: params.audience,
                    style: params.style,
                    theme: params.theme,
                    format: resolvedFormat,
                    documentType: resolvedDocumentType,
                    pageTarget,
                    images: imageAssets,
                  }),
                  documentType: resolvedDocumentType,
                  format: resolvedFormat,
                  tone,
                  length,
                }),
                sourceCount: sources.length,
              };
            }

            if (action === 'assemble') {
              if (sources.length === 0) {
                throw new Error('document-workflow assemble requires one or more source entries.');
              }

              const document = await documentService.assemble(
                sources.map((source) => ({
                  title: source.title || source.sourceLabel || source.id,
                  content: source.content,
                  text: source.content,
                  sourceUrl: source.sourceUrl,
                  sourceLabel: source.sourceLabel,
                })),
                {
                  format: resolvedFormat,
                  title: String(params.title || recommendation.blueprint?.label || 'Research Brief').trim() || 'Research Brief',
                },
              );

              return {
                action,
                sourceCount: sources.length,
                document: await buildPersistedDocumentWorkflowResult(document, context, {
                  includeContent: params.includeContent === true,
                }),
              };
            }

            if (action === 'generate') {
              const structuredPresentation = params.presentation
                && typeof params.presentation === 'object'
                && !Array.isArray(params.presentation)
                ? params.presentation
                : null;
              const groundedPrompt = buildGroundedDocumentPrompt(prompt, sources, {
                title: params.title,
                subtitle: params.subtitle,
                audience: params.audience,
                style: params.style,
                theme: params.theme,
                format: resolvedFormat,
                documentType: resolvedDocumentType,
                pageTarget,
                images: imageAssets,
              });
              if (!groundedPrompt && !structuredPresentation) {
                throw new Error('document-workflow generate requires a prompt or grounded source material.');
              }

              if (structuredPresentation) {
                const document = await documentService.generatePresentation(structuredPresentation, {
                  format: resolvedFormat,
                  model: params.model || context.model || undefined,
                  title: params.title || structuredPresentation.title,
                  subtitle: params.subtitle || structuredPresentation.subtitle,
                  audience: params.audience,
                  style: params.style,
                  theme: params.theme || structuredPresentation.theme,
                  slideCount: params.slideCount,
                  generateImages: params.generateImages,
                  reasoningEffort: params.reasoningEffort || context.reasoningEffort || undefined,
                  qualityPass: params.qualityPass,
                  disableQualityPass: params.disableQualityPass,
                });

                  const workflowDocument = await buildPersistedDocumentWorkflowResult(document, context, {
                    includeContent: params.includeContent === true || useSandboxBuild,
                  });
                  const sandboxBuild = useSandboxBuild && resolvedFormat === 'html'
                    ? await buildDocumentWorkflowSandbox({
                      context,
                      documents: [{
                        format: resolvedFormat,
                        documentType: resolvedDocumentType,
                        document: workflowDocument,
                      }],
                      title: String(params.title || structuredPresentation.title || recommendation.blueprint?.label || 'Document').trim() || 'Document',
                      prompt: groundedPrompt,
                      images: imageAssets,
                    })
                    : null;

                  return {
                    action,
                    recommendation,
                    sourceCount: sources.length,
                    document: workflowDocument,
                    ...(sandboxBuild ? { sandboxBuild } : {}),
                  };
                }

              if (resolvedFormat === 'html'
                && isPreviewableFrontendWorkflowRequest(groundedPrompt)
                && context?.sessionId) {
                try {
                  const generatedArtifact = await artifactService.generateArtifact({
                    session: context.session || null,
                    sessionId: context.sessionId,
                    mode: context.clientSurface || 'chat',
                    prompt: groundedPrompt,
                    format: 'html',
                    artifactIds: [],
                    existingContent: '',
                    model: params.model || context.model || undefined,
                    reasoningEffort: params.reasoningEffort || context.reasoningEffort || undefined,
                  });

                  const workflowDocument = buildArtifactWorkflowResult(generatedArtifact, {
                    includeContent: params.includeContent === true || useSandboxBuild,
                  });
                  const sandboxBuild = useSandboxBuild
                    ? await buildDocumentWorkflowSandbox({
                      context,
                      documents: [{
                        format: 'html',
                        documentType: resolvedDocumentType,
                        document: workflowDocument,
                      }],
                    title: String(params.title || recommendation.blueprint?.label || 'Frontend Artifact').trim() || 'Frontend Artifact',
                    prompt: groundedPrompt,
                    images: imageAssets,
                  })
                    : null;

                  return {
                    action,
                    recommendation,
                    sourceCount: sources.length,
                    document: workflowDocument,
                    ...(sandboxBuild ? { sandboxBuild } : {}),
                  };
                } catch (error) {
                  console.warn(`[document-workflow] Frontend HTML artifact generation failed, falling back to document service: ${error.message}`);
                }
              }

              const document = await documentService.aiGenerate(groundedPrompt, {
                documentType: resolvedDocumentType,
                tone,
                length,
                format: resolvedFormat,
                model: params.model || context.model || undefined,
                title: params.title,
                subtitle: params.subtitle,
                audience: params.audience,
                style: params.style,
                theme: params.theme,
                pageTarget,
                maxPages: pageTarget,
                slideCount: params.slideCount,
                generateImages: params.generateImages,
                qualityPass: params.qualityPass,
                disableQualityPass: params.disableQualityPass,
              });

              const workflowDocument = await buildPersistedDocumentWorkflowResult(document, context, {
                includeContent: params.includeContent === true || useSandboxBuild,
              });
              const sandboxBuild = useSandboxBuild && resolvedFormat === 'html'
                ? await buildDocumentWorkflowSandbox({
                  context,
                  documents: [{
                    format: resolvedFormat,
                    documentType: resolvedDocumentType,
                    document: workflowDocument,
                  }],
                  title: String(params.title || recommendation.blueprint?.label || 'Document').trim() || 'Document',
                  prompt: groundedPrompt,
                  images: imageAssets,
                })
                : null;

              return {
                action,
                recommendation,
                sourceCount: sources.length,
                document: workflowDocument,
                ...(sandboxBuild ? { sandboxBuild } : {}),
              };
            }

            if (action === 'generate-suite') {
              let graphBuild = null;
              let graphImageAssets = [];
              if (graphSpecs.length > 0) {
                graphBuild = await executeNestedTool(context, 'graph-diagram', {
                  title: params.title || recommendation.blueprint?.label || 'Document Suite Graphs',
                  graphs: graphSpecs,
                  outputFormats: ['native', 'mermaid', 'svg', 'html'],
                  renderMode: context?.sessionId ? 'artifact' : 'svg',
                  documentTarget: requestedFormats.includes('pptx') ? 'slides' : 'html',
                  persistArtifacts: Boolean(context?.sessionId),
                  model: params.model || context.model || undefined,
                });
                graphImageAssets = buildGraphImageAssetsFromResult(graphBuild);
                imageAssets = [
                  ...imageAssets,
                  ...graphImageAssets,
                ].slice(0, MAX_VERIFIED_REFERENCE_IMAGES);
              }

              const groundedPrompt = buildGroundedDocumentPrompt(prompt, sources, {
                title: params.title,
                subtitle: params.subtitle,
                audience: params.audience,
                style: params.style,
                theme: params.theme,
                format: requestedFormats.join(', '),
                documentType: resolvedDocumentType,
                pageTarget,
                images: imageAssets,
              });
              if (!groundedPrompt) {
                throw new Error('document-workflow generate-suite requires a prompt or grounded source material.');
              }

              const documents = [];
              for (const suiteFormat of requestedFormats) {
                const suiteRecommendation = suiteFormat === resolvedFormat
                  ? recommendation
                  : documentService.recommendDocumentWorkflow({
                    prompt,
                    documentType: resolvedDocumentType,
                    format: suiteFormat,
                    limit,
                  });
                const suiteDocumentType = suiteRecommendation.inferredType || resolvedDocumentType;

                if (suiteFormat === 'html'
                  && isPreviewableFrontendWorkflowRequest(groundedPrompt)
                  && context?.sessionId) {
                  try {
                    const generatedArtifact = await artifactService.generateArtifact({
                      session: context.session || null,
                      sessionId: context.sessionId,
                      mode: context.clientSurface || 'chat',
                      prompt: groundedPrompt,
                      format: 'html',
                      artifactIds: [],
                      existingContent: '',
                      model: params.model || context.model || undefined,
                      reasoningEffort: params.reasoningEffort || context.reasoningEffort || undefined,
                    });
                    documents.push({
                      format: suiteFormat,
                      documentType: suiteDocumentType,
                      document: buildArtifactWorkflowResult(generatedArtifact, {
                        includeContent: params.includeContent === true || useSandboxBuild,
                      }),
                    });
                    continue;
                  } catch (error) {
                    console.warn(`[document-workflow] Frontend HTML artifact generation failed, falling back to document service: ${error.message}`);
                  }
                }

                const document = await documentService.aiGenerate(groundedPrompt, {
                  documentType: suiteDocumentType,
                  tone,
                  length,
                  format: suiteFormat,
                  model: params.model || context.model || undefined,
                  title: params.title,
                  subtitle: params.subtitle,
                  audience: params.audience,
                  style: params.style,
                  theme: params.theme,
                  pageTarget,
                  maxPages: pageTarget,
                  slideCount: params.slideCount,
                  generateImages: params.generateImages,
                  qualityPass: params.qualityPass,
                  disableQualityPass: params.disableQualityPass,
                });

                documents.push({
                  format: suiteFormat,
                  documentType: suiteDocumentType,
                  document: await buildPersistedDocumentWorkflowResult(document, context, {
                    includeContent: params.includeContent === true || useSandboxBuild,
                  }),
                });
              }

              let sandboxBuild = null;
              if (useSandboxBuild) {
                sandboxBuild = await buildDocumentWorkflowSandbox({
                  context,
                  documents,
                  title: String(params.title || recommendation.blueprint?.label || 'Document Suite').trim() || 'Document Suite',
                  prompt,
                  images: [...rawImageAssets, ...graphImageAssets],
                });
              }

              return {
                action,
                recommendation,
                sourceCount: sources.length,
                formats: requestedFormats,
                pageTarget,
                documents,
                graphBuild,
                sandboxBuild,
              };
            }

            throw new Error(`Unsupported document-workflow action: ${action}`);
          },
          sideEffects: ['write'],
          timeout: 45000
        },
        inputSchema: {
          type: 'object',
          required: ['action'],
          properties: {
            action: {
              type: 'string',
              enum: ['recommend', 'plan', 'generate', 'assemble', 'generate-suite']
            },
            prompt: { type: 'string' },
            request: { type: 'string' },
            topic: { type: 'string' },
            documentType: { type: 'string' },
            format: { type: 'string' },
            formats: {
              type: 'array',
              maxItems: MAX_DOCUMENT_SUITE_FORMATS,
              items: { type: 'string' },
            },
            outputFormats: {
              type: 'array',
              maxItems: MAX_DOCUMENT_SUITE_FORMATS,
              items: { type: 'string' },
            },
            tone: { type: 'string' },
            length: { type: 'string' },
            pageTarget: { type: 'integer', minimum: 1, maximum: 20 },
            maxPages: { type: 'integer', minimum: 1, maximum: 20 },
            buildMode: { type: 'string', enum: ['sandbox', 'scripted', 'code', 'direct'] },
            useSandbox: { type: 'boolean' },
            images: {
              type: 'array',
              maxItems: MAX_VERIFIED_REFERENCE_IMAGES,
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  imageUrl: { type: 'string' },
                  dataUrl: { type: 'string' },
                  contentBase64: { type: 'string' },
                  dataBase64: { type: 'string' },
                  filename: { type: 'string' },
                  path: { type: 'string' },
                  alt: { type: 'string' },
                  title: { type: 'string' },
                  attribution: { type: 'string' },
                  mimeType: { type: 'string' },
                },
              },
            },
            imageAssets: {
              type: 'array',
              maxItems: MAX_VERIFIED_REFERENCE_IMAGES,
              items: { type: 'object' },
            },
            assets: {
              type: 'array',
              maxItems: MAX_VERIFIED_REFERENCE_IMAGES,
              items: { type: 'object' },
            },
            graphs: {
              type: 'array',
              maxItems: 8,
              items: { type: 'object' },
            },
            graphAssets: {
              type: 'array',
              maxItems: 8,
              items: { type: 'object' },
            },
            diagrams: {
              type: 'array',
              maxItems: 8,
              items: { type: 'object' },
            },
            title: { type: 'string' },
            subtitle: { type: 'string' },
            audience: { type: 'string' },
            style: { type: 'string' },
            theme: { type: 'string' },
            slideCount: { type: 'integer' },
            generateImages: { type: 'boolean' },
            model: { type: 'string' },
            reasoningEffort: { type: 'string' },
            qualityPass: { type: 'boolean' },
            disableQualityPass: { type: 'boolean' },
            presentation: { type: 'object' },
            includeContent: { type: 'boolean' },
            limit: { type: 'integer' },
            sources: {
              type: 'array',
              maxItems: MAX_DOCUMENT_SOURCES,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  sourceLabel: { type: 'string' },
                  sourceUrl: { type: 'string' },
                  kind: { type: 'string' },
                  content: { type: 'string' },
                  text: { type: 'string' },
                  body: { type: 'string' },
                  summary: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false
        },
        skill: {
          triggerPatterns: [
            'generate document',
            'create report',
            'create brief',
            'build a deck',
            'make slides',
            'presentation',
            'document workflow',
            'research brief',
            'html document',
            'training manual',
            'training package',
            'learner guide',
            'workbook',
          ],
          requiresConfirmation: false
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'file-text'
        }
      },
      {
        id: DEEP_RESEARCH_PRESENTATION_TOOL_ID,
        name: 'Deep Research Presentation',
        category: 'system',
        description: 'Plan a research-backed presentation, run multiple web research passes, gather verified image sources, and build the final deck in one ordered workflow.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const documentService = resolveDocumentService(context);
            if (!documentService?.aiGenerator?.generatePresentationContent) {
              throw new Error('Deep research presentation generation requires the AI presentation generator.');
            }

            const prompt = String(params.prompt || params.request || params.topic || '').trim();
            if (!prompt) {
              throw new Error('deep-research-presentation requires a prompt, request, or topic.');
            }

            const format = String(params.format || 'pptx').trim().toLowerCase() || 'pptx';
            const documentType = String(params.documentType || 'presentation').trim() || 'presentation';
            const tone = String(params.tone || 'professional').trim() || 'professional';
            const length = String(params.length || 'medium').trim() || 'medium';
            const passCount = normalizePositiveInteger(params.researchPasses, DEFAULT_DEEP_RESEARCH_PASSES, MAX_DEEP_RESEARCH_PASSES);
            const searchLimit = normalizePositiveInteger(params.searchLimit, DEFAULT_DEEP_RESEARCH_SEARCH_LIMIT, MAX_DEEP_RESEARCH_SEARCH_LIMIT);
            const pagesPerPass = normalizePositiveInteger(params.pagesPerPass, DEFAULT_DEEP_RESEARCH_PAGES_PER_PASS, MAX_DEEP_RESEARCH_PAGES_PER_PASS);
            const imageLimit = normalizePositiveInteger(params.imageLimit, DEFAULT_DEEP_RESEARCH_IMAGE_LIMIT, MAX_DEEP_RESEARCH_IMAGE_LIMIT);
            const imageSettleDelayMs = normalizePositiveInteger(
              params.imageSettleDelayMs,
              DEFAULT_IMAGE_SETTLE_DELAY_MS,
              10000,
            );
            const imageMode = String(params.imageMode || 'auto').trim().toLowerCase() || 'auto';
            const searchDomains = normalizeDomainList(params.searchDomains || params.domains || []);
            const researchSafeScrape = params.researchSafeScrape !== false;
            const requestedResearchMode = String(params.researchMode || '').trim().toLowerCase();
            const researchMode = ['fast-search', 'pro-search', 'deep-research', 'advanced-deep-research'].includes(requestedResearchMode)
              ? requestedResearchMode
              : 'deep-research';

            const recommendationData = await executeNestedTool(context, DOCUMENT_WORKFLOW_TOOL_ID, {
              action: 'recommend',
              prompt,
              documentType,
              format,
              limit: params.limit,
            });
            const planData = await executeNestedTool(context, DOCUMENT_WORKFLOW_TOOL_ID, {
              action: 'plan',
              prompt,
              documentType,
              format,
              tone,
              length,
              title: params.title,
              subtitle: params.subtitle,
              audience: params.audience,
              style: params.style,
              theme: params.theme,
              limit: params.limit,
            });

            const recommendation = recommendationData?.recommendation || null;
            const plan = planData?.plan || null;
            const researchQueryPlan = deriveDeepResearchQueries({
              prompt,
              plan,
              researchQueries: params.researchQueries,
              passCount,
            });
            const sourcesByKey = new Map();
            const researchPasses = [];
            let progressKeywords = [];

            for (let passIndex = 0; passIndex < passCount; passIndex += 1) {
              const baseQuery = researchQueryPlan[passIndex] || researchQueryPlan[researchQueryPlan.length - 1] || prompt;
              const query = buildRefinedDeepResearchQuery({
                baseQuery,
                prompt,
                progressKeywords,
              });
              let searchData = null;
              const searchStartedAt = new Date().toISOString();
              try {
                searchData = await executeNestedTool(context, 'web-search', {
                  query,
                  engine: 'perplexity',
                  researchMode,
                  limit: searchLimit,
                  region: String(params.region || 'ca-en').trim() || 'ca-en',
                  timeRange: String(params.timeRange || 'all').trim().toLowerCase() || 'all',
                  includeSnippets: true,
                  includeUrls: true,
                  domains: searchDomains,
                  maxTokens: Math.max(10000, Number(config.search?.defaultMaxTokens || 50000)),
                  maxTokensPerPage: Math.max(1024, Number(config.search?.defaultMaxTokensPerPage || 4096)),
                  userLocation: params.userLocation || { country: 'CA' },
                });
              } catch (error) {
                researchPasses.push({
                  query,
                  status: 'failed',
                  searchStartedAt,
                  error: error.message,
                  verifiedCount: 0,
                  results: [],
                });
                continue;
              }

              const results = Array.isArray(searchData?.results) ? searchData.results : [];
              const verifiedSourcesThisPass = [];
              const passSummary = {
                query,
                status: 'completed',
                searchStartedAt,
                totalResults: Number(searchData?.totalResults || results.length || 0),
                verifiedCount: 0,
                results: [],
              };

              for (const result of results.slice(0, pagesPerPass)) {
                const url = String(result?.url || '').trim();
                if (!url) {
                  continue;
                }

                let fetched = null;
                let kind = 'web-fetch';
                let fetchError = null;

                try {
                  fetched = await executeNestedTool(context, 'web-fetch', {
                    url,
                    timeout: 20000,
                    cache: true,
                  });
                } catch (error) {
                  fetchError = error;
                  try {
                    const approvedHost = getHostnameFromUrl(url);
                    fetched = await executeNestedTool(context, 'web-scrape', {
                      url,
                      browser: true,
                      researchSafe: researchSafeScrape,
                      approvedDomains: approvedHost ? [approvedHost] : [],
                      respectRobotsTxt: researchSafeScrape,
                      timeout: 20000,
                    });
                    kind = 'web-scrape';
                  } catch (scrapeError) {
                    fetchError = scrapeError;
                  }
                }

                if (!fetched) {
                  passSummary.results.push({
                    url,
                    title: String(result?.title || url).trim(),
                    status: 'failed',
                    error: fetchError?.message || 'Unable to verify the result page.',
                  });
                  continue;
                }

                const source = buildDeepResearchSourceFromFetch({
                  fetched,
                  searchResult: result,
                  fallbackUrl: url,
                  kind,
                });
                if (!source) {
                  passSummary.results.push({
                    url,
                    title: String(result?.title || url).trim(),
                    status: 'skipped',
                    tool: kind,
                  });
                  continue;
                }

                const sourceKey = source.sourceUrl || source.id;
                if (!sourcesByKey.has(sourceKey)) {
                  sourcesByKey.set(sourceKey, source);
                }
                verifiedSourcesThisPass.push(source);

                passSummary.results.push({
                  url,
                  title: source.title,
                  status: 'verified',
                  tool: kind,
                  sourceLabel: source.sourceLabel,
                });
              }

              passSummary.verifiedCount = passSummary.results.filter((entry) => entry.status === 'verified').length;
              researchPasses.push(passSummary);

              await storeDeepResearchSourcesInMemory({
                context,
                prompt,
                query,
                passIndex,
                sources: verifiedSourcesThisPass,
              });

              progressKeywords = await deriveDeepResearchProgressKeywords({
                context,
                prompt,
                query,
                sources: Array.from(sourcesByKey.values()),
              });
            }

            const groundedSources = Array.from(sourcesByKey.values());
            const theme = String(params.theme || plan?.themeSuggestion || 'editorial').trim() || 'editorial';
            const groundedPrompt = buildPresentationResearchPrompt({
              prompt,
              sources: groundedSources,
              recommendation,
              plan,
              params,
              format,
            });
            const inferredSlideCount = typeof documentService.inferSlideCount === 'function'
              ? documentService.inferSlideCount(length)
              : undefined;
            const draftPresentation = await documentService.aiGenerator.generatePresentationContent(groundedPrompt, {
              documentType,
              tone,
              length,
              audience: params.audience || 'general audience',
              designPlan: plan,
              theme,
              style: params.style || theme,
              slideCount: params.slideCount || inferredSlideCount,
              model: params.model || context.model || undefined,
              reasoningEffort: params.reasoningEffort || context.reasoningEffort || undefined,
              includeImages: true,
              includeCharts: true,
            });

            const imagesBySlide = new Map();
            const imageQueries = derivePresentationImageQueries({
              prompt,
              presentation: draftPresentation,
              maxImages: imageLimit,
            });
            const imagePasses = [];

            for (const imageQuery of imageQueries) {
              let selectedImage = null;
              let imageSourceTool = '';
              let imageError = null;

              if (imageMode !== 'generated') {
                try {
                  const unsplashData = await executeNestedTool(context, 'image-search-unsplash', {
                    query: imageQuery.query,
                    perPage: 4,
                    orientation: 'landscape',
                  });
                  const candidate = Array.isArray(unsplashData?.images) ? unsplashData.images[0] : null;
                  if (candidate?.url) {
                    if (imageSettleDelayMs > 0) {
                      await delay(imageSettleDelayMs);
                    }
                    const verified = await executeNestedTool(context, 'image-from-url', {
                      url: candidate.url,
                      alt: candidate.alt || imageQuery.title,
                      title: imageQuery.title,
                    });
                    selectedImage = normalizeDeepResearchImage({
                      ...candidate,
                      ...(verified?.image || verified?.images?.[0] || {}),
                      attribution: candidate.author ? `${candidate.author} / Unsplash` : '',
                      sourceKind: 'image-search-unsplash',
                    });
                    imageSourceTool = 'image-search-unsplash';
                  }
                } catch (error) {
                  imageError = error;
                }
              }

              if (!selectedImage && imageMode !== 'stock') {
                try {
                  const generated = await executeNestedTool(context, 'image-generate', {
                    prompt: imageQuery.query,
                    alt: imageQuery.title,
                  });
                  const candidate = generated?.image || generated?.images?.[0] || null;
                  const candidateUrl = String(candidate?.url || '').trim();
                  if (candidateUrl) {
                    if (imageSettleDelayMs > 0) {
                      await delay(imageSettleDelayMs);
                    }
                    const verified = await executeNestedTool(context, 'image-from-url', {
                      url: candidateUrl,
                      alt: candidate.alt || imageQuery.title,
                      title: imageQuery.title,
                    });
                    selectedImage = normalizeDeepResearchImage({
                      ...candidate,
                      ...(verified?.image || verified?.images?.[0] || {}),
                      attribution: 'Generated image',
                      sourceKind: 'image-generate',
                    });
                    imageSourceTool = 'image-generate';
                  }
                } catch (error) {
                  imageError = error;
                }
              }

              if (selectedImage) {
                imagesBySlide.set(imageQuery.slideIndex, selectedImage);
              }

              imagePasses.push({
                slideIndex: imageQuery.slideIndex,
                title: imageQuery.title,
                query: imageQuery.query,
                status: selectedImage ? 'verified' : 'failed',
                tool: imageSourceTool || null,
                image: selectedImage,
                error: selectedImage ? null : (imageError?.message || 'No image source could be verified.'),
              });
            }

            const presentationWithImages = applyImagesToPresentation(draftPresentation, imagesBySlide);
            const finalDocument = await executeNestedTool(context, DOCUMENT_WORKFLOW_TOOL_ID, {
              action: 'generate',
              prompt,
              documentType,
              format,
              tone,
              length,
              title: params.title || presentationWithImages.title,
              subtitle: params.subtitle || presentationWithImages.subtitle,
              audience: params.audience,
              style: params.style,
              theme,
              slideCount: params.slideCount || inferredSlideCount,
              generateImages: imagesBySlide.size < imageQueries.length,
              model: params.model || context.model || undefined,
              reasoningEffort: params.reasoningEffort || context.reasoningEffort || undefined,
              includeContent: params.includeContent === true,
              sources: groundedSources,
              presentation: presentationWithImages,
            });

            return {
              action: 'research_and_generate_presentation',
              recommendation,
              plan,
              researchPasses,
              sourceCount: groundedSources.length,
              sources: groundedSources,
              draftPresentation: {
                title: presentationWithImages.title,
                subtitle: presentationWithImages.subtitle,
                theme: presentationWithImages.theme,
                slideCount: Array.isArray(presentationWithImages.slides) ? presentationWithImages.slides.length : 0,
                slides: (Array.isArray(presentationWithImages.slides) ? presentationWithImages.slides : []).map((slide, index) => ({
                  index: index + 1,
                  layout: slide.layout,
                  title: slide.title,
                  imageUrl: slide.imageUrl || '',
                  imagePrompt: slide.imagePrompt || '',
                })),
              },
              imagePasses,
              verifiedImageCount: imagesBySlide.size,
              images: Array.from(imagesBySlide.entries()).map(([slideIndex, image]) => ({
                slideIndex,
                ...image,
              })),
              document: finalDocument?.document || null,
            };
          },
          sideEffects: ['write', 'network'],
          timeout: 180000,
        },
        inputSchema: {
          type: 'object',
          required: [],
          properties: {
            prompt: { type: 'string' },
            request: { type: 'string' },
            topic: { type: 'string' },
            documentType: { type: 'string' },
            format: { type: 'string' },
            tone: { type: 'string' },
            length: { type: 'string' },
            pageTarget: { type: 'integer', minimum: 1, maximum: 20 },
            maxPages: { type: 'integer', minimum: 1, maximum: 20 },
            title: { type: 'string' },
            subtitle: { type: 'string' },
            audience: { type: 'string' },
            style: { type: 'string' },
            theme: { type: 'string' },
            slideCount: { type: 'integer' },
            model: { type: 'string' },
            reasoningEffort: { type: 'string' },
            includeContent: { type: 'boolean' },
            limit: { type: 'integer' },
            researchPasses: { type: 'integer' },
            researchQueries: { type: 'array' },
            searchLimit: { type: 'integer' },
            searchDomains: {
              type: 'array',
              items: { type: 'string' },
            },
            pagesPerPass: { type: 'integer' },
            imageLimit: { type: 'integer' },
            imageMode: { type: 'string', enum: ['auto', 'stock', 'generated'] },
            imageSettleDelayMs: { type: 'integer' },
            researchSafeScrape: { type: 'boolean' },
            timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year', 'all'] },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: [
            'deep research presentation',
            'deep research deck',
            'research-backed presentation',
            'research-backed slide deck',
            'research slides',
            'research deck',
          ],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'presentation',
        },
      }
    ];

    const mediaTools = [
      {
        id: 'image-generate',
        name: 'Image Generator',
        category: 'system',
        description: 'Generate synthetic visuals through the current OpenAI-compatible image path, persist them as reusable image artifacts, and return hosted URLs for chat, website, HTML, and document builders',
        backend: {
          handler: async (params, context = {}) => {
            const prompts = Array.isArray(params.prompts)
              ? params.prompts.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 5)
              : [];
            const requestedCount = prompts.length > 0
              ? prompts.length
              : Math.min(Math.max(Number(params.n) || 1, 1), 5);
            const response = await generateImageBatch({
              prompt: params.prompt,
              prompts,
              model: params.model || null,
              size: params.size || 'auto',
              quality: params.quality || 'auto',
              style: params.style || null,
              background: params.background || 'auto',
              n: requestedCount,
              batchMode: params.batchMode || (prompts.length > 1 ? 'parallel' : 'auto'),
              concurrency: params.concurrency,
            });
            const persistedImages = await persistGeneratedImages({
              sessionId: context?.sessionId || '',
              sourceMode: 'chat',
              prompt: params.prompt,
              model: response.model || params.model || null,
              images: response.data || [],
            });
            const diagnostics = buildImageGenerationDiagnostics({
              route: 'agent-tool:image-generate',
              stage: 'tool_response_build',
              source: 'agent-tool',
              upstreamDiagnostics: response?.diagnostics?.imageGeneration,
              parsedImages: response?.data || [],
              returnedImages: persistedImages.images || [],
              artifacts: persistedImages.artifacts || [],
              artifactPersistence: persistedImages.artifactPersistence || null,
              requestedCount,
              model: response.model || params.model || null,
              size: response.size || params.size || 'auto',
              quality: response.quality || params.quality || 'auto',
              prompt: params.prompt,
            });

            const images = (persistedImages.images || []).map((image, index) => ({
              url: image.url,
              b64_json: image.b64_json,
              revisedPrompt: image.revised_prompt,
              artifactId: image.artifactId || null,
              downloadUrl: image.downloadUrl || null,
              inlinePath: image.inlinePath || null,
              alt: params.alt || `${params.prompt} ${index + 1}`.trim(),
            }));
            const persistedMarkdownImages = images
              .filter((image) => image.artifactId && image.url)
              .map((image) => `![${image.alt}](${image.url})`);
            const usableImageCount = countUsableImageRecords(images);
            const diagnosticSummary = formatImageDiagnosticsSummary(diagnostics);

            return {
              source: 'generated',
              prompt: params.prompt,
              model: response.model,
              count: images.length,
              usableCount: usableImageCount,
              requestedCount,
              image: images[0] || null,
              images,
              artifacts: persistedImages.artifacts || [],
              artifactIds: (persistedImages.artifactIds || []).slice(),
              artifactPersistence: persistedImages.artifactPersistence || null,
              diagnostics: {
                imageGeneration: diagnostics,
              },
              diagnosticSummary,
              markdownImage: persistedMarkdownImages[0] || null,
              markdownImages: persistedMarkdownImages,
            };
          },
          sideEffects: ['network'],
          timeout: 180000,
        },
        inputSchema: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            prompts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of distinct image prompts. When supplied, the tool generates one image per prompt with bounded parallel calls.',
            },
            alt: { type: 'string' },
            model: { type: 'string' },
            size: { type: 'string' },
            quality: { type: 'string' },
            style: { type: 'string' },
            background: { type: 'string' },
            batchMode: {
              type: 'string',
              enum: ['auto', 'single', 'parallel'],
              description: 'Use auto/single for one OpenAI-compatible n request, or parallel for multiple one-image requests.',
            },
            concurrency: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description: 'Maximum number of parallel image calls when batchMode is parallel.',
            },
            n: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description: 'Number of distinct images to return. Default to 1 and only set this above 1 when the user explicitly asks for multiple images.',
            },
          },
        },
        skill: {
          triggerPatterns: [
            'generate image',
            'make an image',
            'create image',
            'hero image',
            'illustration',
            'generated artwork',
            'synthetic visual',
            'website visual',
            'html visual',
            'document visual',
          ],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'image',
        },
      },
      {
        id: 'image-search-unsplash',
        name: 'Unsplash Image Search',
        category: 'system',
        description: 'Search Unsplash for up to 20 verified stock images and return reusable image URLs with attribution',
        backend: {
          handler: async (params) => {
            if (!isUnsplashConfigured()) {
              throw new Error('Unsplash integration is not configured. Set UNSPLASH_ACCESS_KEY.');
            }

            const results = await searchImages(params.query, {
              page: params.page || 1,
              perPage: Math.min(Math.max(params.perPage || 10, 1), MAX_VERIFIED_REFERENCE_IMAGES),
              orientation: params.orientation,
            });

            const images = (results.results || []).map((image) => ({
              id: image.id,
              url: image.urls?.regular || image.urls?.full || image.urls?.small,
              thumbUrl: image.urls?.thumb || image.urls?.small,
              alt: image.altDescription || image.description || params.query,
              author: image.author?.name || image.user?.name || '',
              authorLink: image.author?.link || image.user?.links?.html || '',
              unsplashLink: image.links?.html || '',
            }));

            return {
              source: 'unsplash',
              query: params.query,
              total: results.total,
              totalPages: results.totalPages,
              images,
              markdownImages: images
                .filter((image) => image.url)
                .map((image) => `![${image.alt}](${image.url})`),
            };
          },
          sideEffects: ['network'],
          timeout: 30000,
        },
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: MAX_VERIFIED_REFERENCE_IMAGES },
            orientation: { type: 'string', enum: ['landscape', 'portrait', 'squarish'] },
          },
        },
        skill: {
          triggerPatterns: ['unsplash', 'stock photo', 'reference image', 'image search', 'photo search'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'image-plus',
        },
      },
      {
        id: 'speech-generate',
        name: 'Speech Generator',
        category: 'system',
        description: 'Synthesize speech with the local TTS provider, save the audio into the active session, and return reusable artifact URLs for downstream agent work.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const sessionId = String(context?.sessionId || '').trim();
            if (!sessionId) {
              throw new Error('speech-generate requires an active session so the audio can be saved.');
            }

            const requestedText = String(params.text || params.prompt || '').trim();
            if (!requestedText) {
              throw new Error('speech-generate requires a `text` string.');
            }

            const synthesis = await ttsService.synthesize({
              text: requestedText,
              voiceId: params.voiceId || '',
            });

            const persistedAudio = await persistGeneratedAudio({
              sessionId,
              sourceMode: String(context?.clientSurface || context?.taskType || 'chat').trim() || 'chat',
              text: synthesis.text,
              title: params.title || '',
              filename: params.filename || '',
              provider: synthesis.provider || synthesis.voice?.provider || 'tts',
              voice: synthesis.voice || null,
              audioBuffer: synthesis.audioBuffer,
              mimeType: synthesis.contentType || 'audio/wav',
              metadata: {
                requestedText,
                createdByAgentTool: true,
              },
            });

            return {
              provider: synthesis.provider || synthesis.voice?.provider || 'tts',
              voice: synthesis.voice || null,
              text: synthesis.text,
              contentType: synthesis.contentType || 'audio/wav',
              artifact: persistedAudio.artifact || null,
              artifacts: persistedAudio.artifact ? [persistedAudio.artifact] : [],
              artifactIds: persistedAudio.artifactIds || [],
              audio: persistedAudio.audio || null,
            };
          },
          sideEffects: ['write', 'execute'],
          timeout: 60000,
        },
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            prompt: { type: 'string' },
            title: { type: 'string' },
            filename: { type: 'string' },
            voiceId: { type: 'string' },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: ['text to speech', 'tts', 'narration', 'voiceover', 'read aloud', 'save audio', 'kokoro', 'piper'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'volume-2',
        },
      },
      {
        id: 'podcast',
        name: 'Podcast',
        category: 'system',
        description: 'Research a topic or use supplied files/source documents, script a user-aligned podcast episode, synthesize the host voices with local TTS, stitch the final podcast audio into a saved artifact, and optionally render an MP4 podcast video. Podcast audio is speaker-only by default; when the user asks to use admin, uploaded, saved, or configured podcast audio sources, set voiceOnlyAudio:false and includeIntro/includeOutro/includeMusicBed as requested so those admin assets are mixed before video rendering. Preserve the full creative brief separately from the topic, including solo-vs-two-host format, required angle, facts, title, exclusions, and any selected scriptDesign/scriptDesignExample. For a training podcast, set scriptDesign:"training-podcast", prefer one calm instructor speaker unless the user asks for multiple speakers, use source documents/files as the curriculum, and set useOnlineResearch:false when those files are sufficient. Prefer proper full scripts over short generic exchanges. Avoid repeated self-referential process language about dissecting, unpacking, cadence, or why the hosts sound human. Visual podcast requests should use storyboard mode with content-matched infographic scenes; waveform-card is the simple audio visualizer fallback.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = resolvePodcastService(context);
            const podcast = await service.createPodcast(params, context);
            if (params.includeVideo !== true) {
              return podcast;
            }

            const videoService = resolvePodcastVideoService(context);
            let videoData = null;
            try {
              videoData = await videoService.createVideoFromPodcast(podcast, {
                sessionId: context.sessionId,
                options: buildPodcastVideoOptions(params, context),
              });
            } catch (error) {
              error.podcastStage = error.podcastStage || 'video-render';
              error.podcastDiagnostics = {
                ...(error.podcastDiagnostics || {}),
                stage: error.podcastStage,
                sessionId: context.sessionId || null,
                topic: params.topic || params.prompt || params.subject || '',
                includeVideo: true,
              };
              console.error('[ToolManager] Podcast video stage failed', {
                stage: error.podcastStage,
                code: error.code || null,
                statusCode: error.statusCode || error.status || null,
                message: error.message,
              });
              throw error;
            }
            const artifacts = [
              ...(Array.isArray(podcast.artifacts) ? podcast.artifacts : []),
              videoData.artifact,
            ].filter(Boolean);

            return {
              ...podcast,
              video: videoData.video,
              videoArtifact: videoData.artifact,
              storyboard: videoData.storyboard,
              artifacts,
              artifactIds: artifacts.map((artifact) => artifact.id).filter(Boolean),
            };
          },
          sideEffects: ['write', 'execute', 'network'],
          timeout: config.podcast?.toolTimeoutMs || 1800000,
        },
        inputSchema: {
          type: 'object',
          required: ['topic'],
          properties: {
            topic: { type: 'string' },
            prompt: { type: 'string' },
            subject: { type: 'string' },
            requestBrief: { type: 'string' },
            originalPrompt: { type: 'string' },
            systemPrompt: {
              type: 'string',
              description: 'Optional production-level instructions layered on top of the base podcast script writer instructions.',
            },
            additionalSystemPrompt: { type: 'string' },
            title: { type: 'string' },
            filename: { type: 'string' },
            durationMinutes: { type: 'integer', minimum: 3, maximum: 30 },
            hostCount: { type: 'integer', minimum: 1, maximum: 2 },
            speakerCount: { type: 'integer', minimum: 1, maximum: 2 },
            timeout: { type: 'integer', minimum: 30000, maximum: 3600000 },
            audience: { type: 'string' },
            tone: { type: 'string' },
            detailLevel: {
              type: 'string',
              enum: ['rich'],
              description: 'Use rich when the user asks for a proper, full, longer, detailed, in-depth, comprehensive, or non-short podcast.',
            },
            scriptDesign: {
              type: 'string',
              description: 'Optional podcast presentation design id, such as classic-explainer, investigative-thread, debate-with-receipts, field-guide, documentary-narrative, technical-deep-dive, training-podcast, case-study, or human-impact. Use training-podcast for calm instructor-led technical training with objectives, modules, worked examples, comprehension checks, and recap.',
            },
            scriptStyle: { type: 'string' },
            presentationDesign: { type: 'string' },
            scriptDesignExample: {
              type: 'string',
              description: 'Optional example of the desired script presentation shape. Use as structural inspiration only; do not copy its facts or repeated wording.',
            },
            presentationExample: { type: 'string' },
            hostAName: { type: 'string' },
            hostARole: { type: 'string' },
            hostAPersona: { type: 'string' },
            hostAVoiceId: { type: 'string' },
            hostAVoiceIds: {
              type: 'array',
              items: { type: 'string' },
            },
            hostBName: { type: 'string' },
            hostBRole: { type: 'string' },
            hostBPersona: { type: 'string' },
            hostBVoiceId: { type: 'string' },
            hostBVoiceIds: {
              type: 'array',
              items: { type: 'string' },
            },
            cycleHostVoices: { type: 'boolean' },
            allowVoiceFallback: { type: 'boolean' },
            allowProviderFallback: { type: 'boolean' },
            allowTtsProviderFallback: { type: 'boolean' },
            artifactIds: {
              type: 'array',
              items: { type: 'string' },
            },
            sourceArtifactIds: {
              type: 'array',
              items: { type: 'string' },
            },
            sourceDocuments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  filename: { type: 'string' },
                  artifactId: { type: 'string' },
                  url: { type: 'string' },
                  summary: { type: 'string' },
                  snippet: { type: 'string' },
                  content: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
            sourceUrls: {
              type: 'array',
              items: { type: 'string' },
            },
            searchDomains: {
              type: 'array',
              items: { type: 'string' },
            },
            useOnlineResearch: {
              type: 'boolean',
              description: 'Defaults to false when uploaded files/sourceDocuments are provided and true otherwise. Set true to enrich supplied files with web research.',
            },
            onlineResearch: { type: 'boolean' },
            webResearch: { type: 'boolean' },
            sourceMode: {
              type: 'string',
              description: 'Use source-only or files-only to rely on supplied files instead of web research; use web-research or sources-plus-web to explicitly enrich with online sources.',
            },
            researchMode: { type: 'string' },
            maxSources: { type: 'integer', minimum: 2, maximum: 6 },
            pauseMs: { type: 'integer', minimum: 100, maximum: 1200 },
            voiceOnlyAudio: {
              type: 'boolean',
              description: 'Defaults to true. Set false only when the user requests admin audio sources, intro/outro, music bed, background music, or other mixed podcast audio.',
            },
            speakerOnlyAudio: { type: 'boolean' },
            voiceOnly: { type: 'boolean' },
            includeIntro: { type: 'boolean' },
            includeOutro: { type: 'boolean' },
            includeMusicBed: { type: 'boolean' },
            introPath: { type: 'string' },
            outroPath: { type: 'string' },
            musicBedPath: { type: 'string' },
            speechVolume: { type: 'number' },
            musicVolume: { type: 'number' },
            introVolume: { type: 'number' },
            outroVolume: { type: 'number' },
            enhanceSpeech: { type: 'boolean' },
            exportMp3: { type: 'boolean' },
            outputFormat: { type: 'string' },
            mp3BitrateKbps: { type: 'integer', minimum: 64, maximum: 320 },
            model: { type: 'string' },
            reasoningEffort: { type: 'string' },
            scriptTimeoutMs: { type: 'integer', minimum: 30000, maximum: 900000 },
            ttsTimeoutMs: { type: 'integer', minimum: 1000, maximum: 900000 },
            ttsChunkMaxChars: { type: 'integer', minimum: 250, maximum: 2400 },
            ttsConcurrency: { type: 'integer', minimum: 1, maximum: 24 },
            researchConcurrency: { type: 'integer', minimum: 1, maximum: 12 },
            includeVideo: { type: 'boolean' },
            video: {
              type: 'object',
              properties: {
                topic: { type: 'string' },
                aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
                imageMode: { type: 'string', enum: ['mixed', 'web', 'unsplash', 'generated', 'fallback', 'provided'] },
                generateImages: { type: 'boolean' },
                enhanceAudio: { type: 'boolean' },
                visualEffects: { type: 'boolean' },
                sceneCount: { type: 'integer', minimum: 1, maximum: 36 },
                generatedImageRatio: { type: 'integer', minimum: 0, maximum: 20 },
                renderMode: { type: 'string', enum: ['waveform-card', 'static-card', 'storyboard'] },
                visualStyle: { type: 'string' },
                imageModel: { type: 'string' },
                model: { type: 'string' },
                reasoningEffort: { type: 'string' },
                ffmpegTimeoutMs: { type: 'integer', minimum: 30000, maximum: 2700000 },
                segmentTimeoutMs: { type: 'integer', minimum: 30000, maximum: 2700000 },
                muxTimeoutMs: { type: 'integer', minimum: 60000, maximum: 2700000 },
              },
              additionalProperties: false,
            },
            videoAspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
            videoImageMode: { type: 'string', enum: ['mixed', 'web', 'unsplash', 'generated', 'fallback', 'provided'] },
            videoGenerateImages: { type: 'boolean' },
            videoEnhanceAudio: { type: 'boolean' },
            videoVisualEffects: { type: 'boolean' },
            visualEffects: { type: 'boolean' },
            videoSceneCount: { type: 'integer', minimum: 1, maximum: 36 },
            videoGeneratedImageRatio: { type: 'integer', minimum: 0, maximum: 20 },
            videoRenderMode: { type: 'string', enum: ['waveform-card', 'static-card', 'storyboard'] },
            renderMode: { type: 'string', enum: ['waveform-card', 'static-card', 'storyboard'] },
            videoVisualStyle: { type: 'string' },
            videoImageModel: { type: 'string' },
            videoModel: { type: 'string' },
            videoReasoningEffort: { type: 'string' },
            videoFfmpegTimeoutMs: { type: 'integer', minimum: 30000, maximum: 2700000 },
            videoSegmentTimeoutMs: { type: 'integer', minimum: 30000, maximum: 2700000 },
            videoMuxTimeoutMs: { type: 'integer', minimum: 60000, maximum: 2700000 },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: [
            'podcast',
            'podcast episode',
            'video podcast',
            'podcast video',
            'mp4 podcast',
            'solo podcast',
            'training podcast',
            'one speaker podcast',
            'two host podcast',
            'research and script audio',
            'two agent voices',
            'podcast conversation',
          ],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'mic',
        },
      },
      {
        id: 'image-from-url',
        name: 'Image URL Reference',
        category: 'system',
        description: 'Validate, verify, and normalize up to 20 direct image URLs so they can be saved and reused in document output',
        backend: {
          handler: async (params) => {
            const urlCandidates = [
              ...(Array.isArray(params.urls) ? params.urls : []),
              ...(params.url ? [params.url] : []),
            ];
            const normalizedUrls = urlCandidates
              .map((value) => {
                try {
                  return normalizeCandidateUrl(value);
                } catch (_error) {
                  return null;
                }
              })
              .filter((value, index, array) => value && array.indexOf(value) === index)
              .slice(0, MAX_VERIFIED_REFERENCE_IMAGES);

            if (normalizedUrls.length === 0) {
              throw new Error('Provide a direct image `url` or up to 20 image `urls`.');
            }

            const results = await Promise.allSettled(normalizedUrls.map(async (candidateUrl, index) => {
              const parsed = new URL(candidateUrl);
              if (!['http:', 'https:'].includes(parsed.protocol)) {
                throw new Error('Only http and https image URLs are supported.');
              }

              const verified = await verifyDirectImageUrl(parsed.toString());
              const alt = Array.isArray(params.alts) && typeof params.alts[index] === 'string'
                ? params.alts[index]
                : (params.alt || deriveImageAltText(verified.url, 'image'));

              return {
                url: verified.url,
                alt,
                title: params.title || '',
                host: new URL(verified.url).host,
                mimeType: verified.mimeType,
                verified: true,
                verificationMethod: verified.verificationMethod,
              };
            }));

            const images = [];
            const rejected = [];
            results.forEach((result, index) => {
              if (result.status === 'fulfilled') {
                images.push(result.value);
                return;
              }

              rejected.push({
                inputIndex: index + 1,
                error: result.reason?.message || 'Image verification failed.',
              });
            });

            if (images.length === 0) {
              throw new Error(rejected[0]?.error || 'Image verification failed.');
            }

            const primaryImage = images[0];
            return {
              source: 'url',
              verified: true,
              verifiedCount: images.length,
              image: primaryImage,
              images,
              rejected,
              normalizedUrl: primaryImage.url,
              markdownImage: `![${primaryImage.alt}](${primaryImage.url})`,
              markdownImages: images.map((image) => `![${image.alt}](${image.url})`),
            };
          },
          sideEffects: ['network'],
          timeout: 30000,
        },
        inputSchema: {
          type: 'object',
          required: [],
          properties: {
            url: { type: 'string' },
            urls: {
              type: 'array',
              description: 'Optional batch of up to 20 direct image URLs to verify and normalize in one call.',
            },
            alt: { type: 'string' },
            alts: {
              type: 'array',
              description: 'Optional alt-text array matching the order of `urls`.',
            },
            title: { type: 'string' },
          },
        },
        skill: {
          triggerPatterns: ['image url', 'use this image', 'embed image', 'reference image url'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'link',
        },
      },
    ];

    const workloadTools = [
      {
        id: 'agent-delegate',
        name: 'Sub-Agent Orchestrator',
        category: 'system',
        description: 'Spawn and track up to 3 bounded sub-agents for long-running background work in the current conversation. Sub-agents inherit the caller model, cannot spawn more sub-agents, and should use distinct write targets when they modify files.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const { service, ownerId, sessionId } = resolveSessionWorkloadService(context);
            const action = normalizeWorkloadAction(params.action || 'spawn');

            if (action === 'spawn') {
              const orchestration = await service.spawnSubAgents(params, ownerId, {
                sessionId,
                model: context?.model || null,
                parentRunId: context?.runId || context?.parentRunId || null,
                subAgentDepth: context?.subAgentDepth || 0,
              });

              return {
                action,
                sessionId,
                orchestration,
                message: `Queued ${orchestration.taskCount} sub-agent task${orchestration.taskCount === 1 ? '' : 's'} in ${orchestration.orchestrationId}.`,
              };
            }

            if (action === 'status') {
              const orchestrationId = String(
                params.orchestrationId
                || params.orchestration_id
                || params.id
                || '',
              ).trim();
              if (!orchestrationId) {
                throw new Error('agent-delegate status requires an `orchestrationId`.');
              }

              const orchestration = await service.getSubAgentOrchestration(orchestrationId, ownerId, sessionId);
              if (!orchestration) {
                throw new Error('Sub-agent orchestration not found.');
              }

              return {
                action,
                sessionId,
                orchestration,
              };
            }

            if (action === 'list') {
              const orchestrations = await service.listSubAgentOrchestrations(sessionId, ownerId);
              return {
                action,
                sessionId,
                count: orchestrations.length,
                orchestrations,
              };
            }

            throw new Error(`Unsupported agent-delegate action: ${action}`);
          },
          sideEffects: ['write'],
          timeout: 15000,
        },
        inputSchema: {
          type: 'object',
          required: ['action'],
          properties: {
            action: {
              type: 'string',
              enum: ['spawn', 'status', 'list'],
            },
            title: { type: 'string' },
            name: { type: 'string' },
            orchestrationId: { type: 'string' },
            orchestration_id: { type: 'string' },
            maxRetries: { type: 'integer' },
            task: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                name: { type: 'string' },
                prompt: { type: 'string' },
                objective: { type: 'string' },
                request: { type: 'string' },
                mode: { type: 'string' },
                toolIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
                executionProfile: { type: 'string' },
                execution_profile: { type: 'string' },
                allowSideEffects: { type: 'boolean' },
                maxRounds: { type: 'integer' },
                maxToolCalls: { type: 'integer' },
                maxDurationMs: { type: 'integer' },
                maxRetries: { type: 'integer' },
                lockKey: { type: 'string' },
                lock_key: { type: 'string' },
                writeTargets: {
                  type: 'array',
                  items: { type: 'string' },
                },
                write_targets: {
                  type: 'array',
                  items: { type: 'string' },
                },
                outputPath: { type: 'string' },
                output_path: { type: 'string' },
                targetPath: { type: 'string' },
                target_path: { type: 'string' },
                path: { type: 'string' },
                execution: { type: 'object' },
                metadata: { type: 'object' },
              },
              additionalProperties: false,
            },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  name: { type: 'string' },
                  prompt: { type: 'string' },
                  objective: { type: 'string' },
                  request: { type: 'string' },
                  mode: { type: 'string' },
                  toolIds: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  executionProfile: { type: 'string' },
                  execution_profile: { type: 'string' },
                  allowSideEffects: { type: 'boolean' },
                  maxRounds: { type: 'integer' },
                  maxToolCalls: { type: 'integer' },
                  maxDurationMs: { type: 'integer' },
                  maxRetries: { type: 'integer' },
                  lockKey: { type: 'string' },
                  lock_key: { type: 'string' },
                  writeTargets: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  write_targets: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  outputPath: { type: 'string' },
                  output_path: { type: 'string' },
                  targetPath: { type: 'string' },
                  target_path: { type: 'string' },
                  path: { type: 'string' },
                  execution: { type: 'object' },
                  metadata: { type: 'object' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: [
            'sub-agent',
            'sub agent',
            'delegate task',
            'parallel task',
            'spawn worker',
          ],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'layers',
        },
      },
      {
        id: 'agent-workload',
        name: 'Agent Workload Manager',
        category: 'system',
        description: 'Create and manage deferred agent workloads for later, recurring, and follow-up work tied to the current conversation session. For scheduled requests, pass the full user request and let the runtime extract the schedule and remote command details.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const { service, ownerId, sessionId } = resolveSessionWorkloadService(context);
            const action = normalizeWorkloadAction(params.action);

            if (action === 'list') {
              const workloads = await service.listSessionWorkloads(sessionId, ownerId);
              return {
                action,
                sessionId,
                count: workloads.length,
                workloads,
              };
            }

            if (action === 'create_from_scenario') {
              const request = String(params.request || params.scenario || params.description || '').trim();
              const session = service.sessionStore?.getOwned
                ? await service.sessionStore.getOwned(sessionId, ownerId)
                : null;
              const normalized = buildNormalizedWorkloadPayload({
                ...params,
                ...(request ? { request } : {}),
              }, context, session);
              if (!normalized) {
                throw new Error('agent-workload create_from_scenario requires a recoverable scheduled request or an explicit manual request with a structured workload payload.');
              }

              assertWorkloadSchedulingIntent(normalized.payload, context);

              const workload = await service.createWorkload(applyWorkloadExecutionPreferences({
                ...normalized.payload,
                sessionId,
              }, params, context), ownerId);

              return {
                action,
                sessionId,
                workload,
                scenario: normalized.scenario,
                message: `${workload.title} created. ${summarizeTrigger(workload.trigger || {})}.${buildWorkloadWarningSuffix(workload)}`,
              };
            }

            if (action === 'create') {
              const session = service.sessionStore?.getOwned
                ? await service.sessionStore.getOwned(sessionId, ownerId)
                : null;
              const normalized = buildNormalizedWorkloadPayload(params, context, session);
              const payload = normalized?.payload || params;
              assertWorkloadSchedulingIntent(payload, context);
              const workload = await service.createWorkload(applyWorkloadExecutionPreferences({
                ...payload,
                sessionId,
              }, params, context), ownerId);
              return {
                action,
                sessionId,
                workload,
                message: `${workload.title} created. ${summarizeTrigger(workload.trigger || {})}.${buildWorkloadWarningSuffix(workload)}`,
              };
            }

            if (action === 'run_now') {
              const run = await service.runWorkloadNow(
                params.idOrSlug || params.workloadId || params.callableSlug || '',
                ownerId,
                {
                  reason: 'manual',
                  metadata: params.metadata || {},
                },
              );
              if (!run) {
                throw new Error('Workload not found.');
              }

              return {
                action,
                sessionId,
                run,
                message: `Queued workload run ${run.id} for immediate execution.`,
              };
            }

            if (action === 'pause') {
              const workload = await service.pauseWorkload(
                params.idOrSlug || params.workloadId || params.callableSlug || '',
                ownerId,
              );
              if (!workload) {
                throw new Error('Workload not found.');
              }

              return {
                action,
                sessionId,
                workload,
                message: `${workload.title} paused.`,
              };
            }

            if (action === 'resume') {
              const workload = await service.resumeWorkload(
                params.idOrSlug || params.workloadId || params.callableSlug || '',
                ownerId,
              );
              if (!workload) {
                throw new Error('Workload not found.');
              }

              return {
                action,
                sessionId,
                workload,
                message: `${workload.title} resumed.`,
              };
            }

            if (action === 'delete') {
              const deleted = await service.deleteWorkload(
                params.idOrSlug || params.workloadId || params.callableSlug || '',
                ownerId,
              );
              if (!deleted) {
                throw new Error('Workload not found.');
              }

              return {
                action,
                sessionId,
                deleted: true,
                message: 'Workload deleted.',
              };
            }

            if (action === 'list_runs') {
              const workloadId = params.idOrSlug || params.workloadId || '';
              const runs = await service.listRunsForWorkload(
                workloadId,
                ownerId,
                Number.isFinite(Number(params.limit))
                  ? Math.max(1, Math.min(Number(params.limit), 100))
                  : 20,
              );

              return {
                action,
                sessionId,
                workloadId,
                count: runs.length,
                runs,
              };
            }

            if (action === 'get_project') {
              const workloadId = params.idOrSlug || params.workloadId || params.callableSlug || '';
              const project = await service.getProjectPlan(workloadId, ownerId);
              if (!project) {
                throw new Error('Project workload not found.');
              }

              return {
                action,
                sessionId,
                workloadId,
                project,
              };
            }

            if (action === 'update_project') {
              const workloadId = params.idOrSlug || params.workloadId || params.callableSlug || '';
              const updated = await service.updateProjectPlan(
                workloadId,
                ownerId,
                params.project || {},
                {
                  changeReason: params.changeReason || params.change_reason || null,
                },
              );
              if (!updated) {
                throw new Error('Project workload not found.');
              }

              return {
                action,
                sessionId,
                workloadId,
                workload: updated.workload,
                project: updated.project,
                message: 'Project plan updated.',
              };
            }

            throw new Error(`Unsupported agent-workload action: ${action}`);
          },
          sideEffects: ['write'],
          timeout: 15000,
        },
        inputSchema: {
          type: 'object',
          required: ['action'],
          properties: {
            action: {
              type: 'string',
              enum: ['create_from_scenario', 'create', 'list', 'run_now', 'pause', 'resume', 'delete', 'list_runs', 'get_project', 'update_project'],
            },
            request: { type: 'string' },
            scenario: { type: 'string' },
            description: { type: 'string' },
            title: { type: 'string' },
            prompt: { type: 'string' },
            execution: { type: 'object' },
            callableSlug: { type: 'string' },
            tool: { type: 'string' },
            command: { type: 'string' },
            schedule: { type: 'string' },
            mode: { type: 'string' },
            enabled: { type: 'boolean' },
            timezone: { type: 'string' },
            now: { type: 'string' },
            trigger: { type: 'object' },
            policy: { type: 'object' },
            stages: { type: 'array' },
            metadata: { type: 'object' },
            project: { type: 'object' },
            changeReason: { type: 'object' },
            host: { type: 'string' },
            username: { type: 'string' },
            port: { type: 'integer' },
            idOrSlug: { type: 'string' },
            workloadId: { type: 'string' },
            limit: { type: 'integer' },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: [
            'schedule this for later',
            'set up a recurring agent',
            'create a daily workload',
            'follow up tomorrow',
            'run every weekday',
          ],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'clock',
        },
      },
    ];

    const interactionTools = [
      {
        id: USER_CHECKPOINT_TOOL_ID,
        name: 'User Checkpoint',
        category: 'system',
        description: 'Primary quick user-involvement path for web chat: use a lightweight checkpoint card for a high-impact decision or a short structured questionnaire before or during major work. Keep it to one checkpoint card with one visible step at a time. Choice options must be answerable user decisions, not remote status rows, deployment proof, file paths, git status, verification results, or progress summaries. Supports choice, multi-choice, text, date, time, and datetime prompts. Use this instead of `request_user_input`.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const policy = context?.userCheckpointPolicy || {};
            const hasPendingCheckpoint = Boolean(policy?.pending?.id);
            const remainingQuestions = Number(policy?.remaining ?? 0);

            if (policy?.answeredThisTurn === true) {
              throw new Error('The latest user turn already answered a checkpoint. Continue from that answer instead of asking another checkpoint.');
            }

            if (hasPendingCheckpoint) {
              throw new Error('A user checkpoint is already pending in this session.');
            }

            if (policy?.enabled !== true) {
              throw new Error('User checkpoints are only available in the web chat surface.');
            }

            if (remainingQuestions <= 0) {
              throw new Error('No checkpoint questions remain in this session. Continue with the best reasonable assumption.');
            }

            const checkpoint = normalizeCheckpointRequest(params);
            return {
              checkpoint,
              message: buildUserCheckpointMessage(checkpoint),
            };
          },
          sideEffects: [],
          timeout: 5000,
        },
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            preamble: { type: 'string' },
            question: { type: 'string' },
            prompt: { type: 'string' },
            ask: { type: 'string' },
            label: { type: 'string' },
            message: { type: 'string' },
            whyThisMatters: { type: 'string' },
            context: { type: 'string' },
            rationale: { type: 'string' },
            inputType: { type: 'string' },
            fieldType: { type: 'string' },
            type: { type: 'string' },
            kind: { type: 'string' },
            placeholder: { type: 'string' },
            inputPlaceholder: { type: 'string' },
            freeTextPlaceholder: { type: 'string' },
            allowMultiple: { type: 'boolean' },
            multiple: { type: 'boolean' },
            maxSelections: { type: 'integer' },
            allowFreeText: { type: 'boolean' },
            allowText: { type: 'boolean' },
            freeTextLabel: { type: 'string' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 5,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  value: { type: 'string' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
                additionalProperties: false,
              },
            },
            choices: {
              type: 'array',
              minItems: 2,
              maxItems: 5,
              items: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      value: { type: 'string' },
                      label: { type: 'string' },
                      title: { type: 'string' },
                      text: { type: 'string' },
                      description: { type: 'string' },
                      details: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                ],
              },
            },
            steps: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  question: { type: 'string' },
                  prompt: { type: 'string' },
                  ask: { type: 'string' },
                  label: { type: 'string' },
                  inputType: { type: 'string' },
                  fieldType: { type: 'string' },
                  type: { type: 'string' },
                  kind: { type: 'string' },
                  placeholder: { type: 'string' },
                  inputPlaceholder: { type: 'string' },
                  freeTextPlaceholder: { type: 'string' },
                  required: { type: 'boolean' },
                  allowMultiple: { type: 'boolean' },
                  multiple: { type: 'boolean' },
                  maxSelections: { type: 'integer' },
                  allowFreeText: { type: 'boolean' },
                  allowText: { type: 'boolean' },
                  freeTextLabel: { type: 'string' },
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 5,
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        value: { type: 'string' },
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                      required: ['label'],
                      additionalProperties: false,
                    },
                  },
                  choices: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 5,
                    items: {
                      oneOf: [
                        { type: 'string' },
                        {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            value: { type: 'string' },
                            label: { type: 'string' },
                            title: { type: 'string' },
                            text: { type: 'string' },
                            description: { type: 'string' },
                            details: { type: 'string' },
                          },
                          additionalProperties: false,
                        },
                      ],
                    },
                  },
                },
                additionalProperties: false,
              },
            },
            fields: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  label: { type: 'string' },
                  question: { type: 'string' },
                  prompt: { type: 'string' },
                  ask: { type: 'string' },
                  inputType: { type: 'string' },
                  fieldType: { type: 'string' },
                  type: { type: 'string' },
                  kind: { type: 'string' },
                  placeholder: { type: 'string' },
                  inputPlaceholder: { type: 'string' },
                  freeTextPlaceholder: { type: 'string' },
                  required: { type: 'boolean' },
                  allowMultiple: { type: 'boolean' },
                  multiple: { type: 'boolean' },
                  maxSelections: { type: 'integer' },
                  allowFreeText: { type: 'boolean' },
                  allowText: { type: 'boolean' },
                  freeTextLabel: { type: 'string' },
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 5,
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        value: { type: 'string' },
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                      required: ['label'],
                      additionalProperties: false,
                    },
                  },
                  choices: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 5,
                    items: {
                      oneOf: [
                        { type: 'string' },
                        {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            value: { type: 'string' },
                            label: { type: 'string' },
                            title: { type: 'string' },
                            text: { type: 'string' },
                            description: { type: 'string' },
                            details: { type: 'string' },
                          },
                          additionalProperties: false,
                        },
                      ],
                    },
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: ['clarify before major work', 'ask a checkpoint question', 'multiple choice question', 'questionnaire tool', 'questionaire', 'survey tool', 'test the questionnaire tool', 'quick user choice', 'quick checkpoint', 'involve the user quickly', 'ask me a survey', 'inline survey', 'survey card', 'checkpoint card', 'open ended question', 'time based question', 'questionnaire intake'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: false,
          icon: 'list-checks',
        },
      },
    ];

    const systemToolInstances = [
      new GitLocalTool(),
    ];

    const skillTools = [
      {
        id: SELF_REFLECTION_UPDATE_TOOL_ID,
        name: 'Self Reflection Update',
        category: 'system',
        description: 'Apply a bounded self-reflection update to Hermes-style soul/user files, durable carryover notes, registered skills, and model-card audit notes.',
        backend: {
          handler: async (params = {}) => applySelfReflectionUpdate(params),
          sideEffects: ['write'],
          timeout: 10000,
        },
        inputSchema: {
          type: 'object',
          properties: {
            trigger: {
              type: 'string',
              description: 'Short description of the correction, learning, model-card finding, or workflow outcome that triggered this update.',
            },
            reflection: {
              type: 'string',
              description: 'Concise self-reflection explaining why the durable update is warranted.',
            },
            source: {
              type: 'string',
              description: 'Source of the reflection, such as user_turn, model_card, post_task_review, or user_requested.',
            },
            recursionDepth: {
              type: 'integer',
              description: 'Must be 0 or omitted. Nested reflection updates are rejected.',
            },
            targetSkillId: {
              type: 'string',
              description: 'Optional default skill id for skill_patch or skill_update actions.',
            },
            dryRun: {
              type: 'boolean',
              description: 'When true, validate the proposed updates without writing soul/user files, notes, skills, or audit logs.',
            },
            apply: {
              type: 'boolean',
              description: 'Set false to validate only. Omit or set true to apply validated actions.',
            },
            actions: {
              type: 'array',
              maxItems: SELF_REFLECTION_UPDATE_ACTION_LIMIT,
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    description: 'One of soul_replace, user_profile_replace, agent_notes_replace, carryover_notes_replace, skill_patch, skill_update, skill_create, or model_card_note.',
                  },
                  reason: { type: 'string' },
                  content: { type: 'string' },
                  notes: { type: 'string' },
                  id: { type: 'string' },
                  skillId: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  body: { type: 'string' },
                  instructions: { type: 'string' },
                  oldText: { type: 'string' },
                  newText: { type: 'string' },
                  old_string: { type: 'string' },
                  new_string: { type: 'string' },
                  tools: { type: 'array', items: { type: 'string' } },
                  triggerPatterns: { type: 'array', items: { type: 'string' } },
                  chain: { type: 'array' },
                  contextPolicy: { type: 'object' },
                  enabled: { type: 'boolean' },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: [
            'self reflection update',
            'recursive update',
            'full hermes',
            'hermes user.md',
            'update soul.md',
            'update user.md',
            'model card update',
            'update user files',
            'update the skill',
            'remember this workflow',
          ],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'sparkles',
        },
      },
      {
        id: 'managed-app',
        name: 'Managed App',
        category: 'deployment',
        description: 'Create, update, inspect, reconcile, and deploy GitLab-backed managed apps with visible repository, pipeline, registry, and build-event state.',
        backend: {
          handler: async (params = {}, context = {}) => {
            const service = resolveManagedAppService(context);
            const action = String(params.action || 'inspect').trim().toLowerCase();
            const ownerId = context.ownerId || context.userId || null;
            const input = {
              ...params,
              sessionId: params.sessionId || context.sessionId || null,
            };

            switch (action) {
              case 'create':
                return service.createApp(input, ownerId, context);
              case 'update':
                return service.updateApp(params.appRef || params.ref || params.slug || params.id, input, ownerId, context);
              case 'iterate':
              case 'iteration':
              case 'edit':
              case 'build':
              case 'verify':
                return service.iterateApp(params.appRef || params.ref || params.slug || params.id, {
                  ...input,
                  action: params.iterationAction || (action === 'iterate' || action === 'iteration' ? (params.requestedAction || 'edit') : action),
                }, ownerId, context);
              case 'deploy':
                return service.deployApp(params.appRef || params.ref || params.slug || params.id, input, ownerId, context);
              case 'inspect':
              case 'status':
                return service.inspectApp(params.appRef || params.ref || params.slug || params.id, ownerId, context);
              case 'doctor':
              case 'diagnose':
              case 'diagnostic':
              case 'diagnostics':
                return service.doctorPlatform(input, ownerId, context);
              case 'reconcile':
              case 'repair':
              case 'repair-runner':
                return service.reconcilePlatform(input, ownerId, context);
              case 'list':
                return service.listApps(ownerId, input.limit || 50);
              default:
                throw new Error(`Unsupported managed-app action: ${action}`);
            }
          },
          sideEffects: ['write', 'execute'],
          timeout: 600000,
        },
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'update', 'iterate', 'iteration', 'edit', 'build', 'deploy', 'verify', 'inspect', 'status', 'doctor', 'diagnose', 'diagnostic', 'diagnostics', 'reconcile', 'repair', 'repair-runner', 'list'] },
            appRef: { type: 'string' },
            ref: { type: 'string' },
            id: { type: 'string' },
            slug: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            sourcePrompt: { type: 'string' },
            requestedAction: { type: 'string' },
            iterationAction: { type: 'string', enum: ['edit', 'build', 'deploy', 'verify'] },
            executor: { type: 'string', enum: ['managed-app-backend', 'remote-cli-agent', 'backend-cli-agent'] },
            useRemoteCliAgent: { type: 'boolean' },
            backendCliAgent: { type: 'boolean' },
            remoteCliAgent: { type: 'boolean' },
            remoteCliTargetId: { type: 'string' },
            remoteCliCwd: { type: 'string' },
            remoteCliSessionId: { type: 'string' },
            waitMs: { type: 'number' },
            maxTurns: { type: 'number' },
            deployTarget: { type: 'string' },
            deploymentTarget: { type: 'string' },
            publicHost: { type: 'string' },
            namespace: { type: 'string' },
            imageTag: { type: 'string' },
            runnerToken: { type: 'string' },
            runnerLabels: { type: 'string' },
            runnerReplicas: { type: 'number' },
            platformNamespace: { type: 'string' },
            sessionId: { type: 'string' },
          },
          additionalProperties: true,
        },
        skill: {
          triggerPatterns: ['managed app', 'gitlab managed app', 'gitlab ci build', 'gitlab runner', 'build events webhook', 'gitlab observable deploy'],
          requiresConfirmation: true,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'git-branch',
          requiresSetup: true,
        },
      },
      {
        id: 'skill-list',
        name: 'Skill List',
        category: 'system',
        description: 'List registered low-context skills that can complement tool workflows.',
        backend: {
          handler: async (params = {}) => ({
            skills: skillStore.listSkills({
              search: params.search || params.query || '',
              includeDisabled: params.includeDisabled === true,
              includeBody: params.includeBody === true,
            }),
            registry: skillStore.getSummary(),
          }),
          sideEffects: [],
          timeout: 5000,
        },
        inputSchema: {
          type: 'object',
          properties: {
            search: { type: 'string' },
            query: { type: 'string' },
            includeDisabled: { type: 'boolean' },
            includeBody: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: ['list skills', 'show skills', 'registered skills', 'skill catalog'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'brain',
        },
      },
      {
        id: 'skill-read',
        name: 'Skill Read',
        category: 'system',
        description: 'Read one registered skill, including its compact workflow instructions.',
        backend: {
          handler: async (params = {}) => {
            const skill = skillStore.readSkill(params.id || params.skillId || params.name || '', {
              includeBody: params.includeBody !== false,
            });
            if (!skill) {
              throw new Error('Skill not found.');
            }
            return { skill };
          },
          sideEffects: [],
          timeout: 5000,
        },
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            skillId: { type: 'string' },
            name: { type: 'string' },
            includeBody: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: ['read skill', 'skill details', 'show skill instructions'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'book-open',
        },
      },
      {
        id: 'skill-create',
        name: 'Skill Create',
        category: 'system',
        description: 'Create a file-backed skill manifest under the registered skill location for reusable tool chains.',
        backend: {
          handler: async (params = {}) => ({
            skill: skillStore.upsertSkill(params, { createOnly: true }),
            registry: skillStore.getSummary(),
          }),
          sideEffects: ['write'],
          timeout: 10000,
        },
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            body: { type: 'string' },
            instructions: { type: 'string' },
            tools: { type: 'array', items: { type: 'string' } },
            triggerPatterns: { type: 'array', items: { type: 'string' } },
            chain: { type: 'array' },
            contextPolicy: { type: 'object' },
            enabled: { type: 'boolean' },
          },
          additionalProperties: true,
        },
        skill: {
          triggerPatterns: ['create skill', 'make a skill', 'skill creator', 'save this workflow as a skill', 'register a skill'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'plus-circle',
        },
      },
      {
        id: 'skill-update',
        name: 'Skill Update',
        category: 'system',
        description: 'Update an existing file-backed skill manifest and instructions.',
        backend: {
          handler: async (params = {}) => ({
            skill: skillStore.upsertSkill(params, { updateOnly: true }),
            registry: skillStore.getSummary(),
          }),
          sideEffects: ['write'],
          timeout: 10000,
        },
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            body: { type: 'string' },
            instructions: { type: 'string' },
            tools: { type: 'array', items: { type: 'string' } },
            triggerPatterns: { type: 'array', items: { type: 'string' } },
            chain: { type: 'array' },
            contextPolicy: { type: 'object' },
            enabled: { type: 'boolean' },
          },
          additionalProperties: true,
        },
        skill: {
          triggerPatterns: ['update skill', 'edit skill', 'skill updater', 'revise this skill'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'pencil',
        },
      },
      {
        id: 'skill-context',
        name: 'Skill Context',
        category: 'system',
        description: 'Return the compact registered-skills prompt block that matches a request and optional tool ids.',
        backend: {
          handler: async (params = {}) => ({
            context: skillStore.buildContextBlock({
              text: params.text || params.prompt || params.request || '',
              toolIds: params.toolIds || params.tools || [],
              selectedSkillIds: params.skillIds || params.skills || [],
              limit: params.limit,
            }),
            registry: skillStore.getSummary(),
          }),
          sideEffects: [],
          timeout: 5000,
        },
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            prompt: { type: 'string' },
            request: { type: 'string' },
            toolIds: { type: 'array', items: { type: 'string' } },
            tools: { type: 'array', items: { type: 'string' } },
            skillIds: { type: 'array', items: { type: 'string' } },
            skills: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer' },
          },
          additionalProperties: false,
        },
        skill: {
          triggerPatterns: ['skill context', 'match skills', 'skills for this request'],
          requiresConfirmation: false,
        },
        frontend: {
          exposeToFrontend: true,
          icon: 'route',
        },
      },
    ];

    // Register all system tools
    [...fileTools, ...codeTools, ...docsTools, ...mediaTools, ...workloadTools, ...interactionTools, ...skillTools].forEach(def => {
      this.registry.register({
        ...def,
        version: '1.0.0',
        skill: def.skill || {
          triggerPatterns: [def.name.toLowerCase(), def.id.replace(/-/g, ' ')],
          autoApply: false
        },
        frontend: def.frontend || {
          exposeToFrontend: true,
          icon: 'settings'
        }
      });
    });

    systemToolInstances.forEach((tool) => {
      const definition = this.createToolDefinition(tool, {
        frontend: {
          exposeToFrontend: true,
          icon: tool.id === 'git-safe' ? 'git-branch' : 'settings',
        },
        skill: {
          triggerPatterns: [tool.name.toLowerCase(), tool.id.replace(/-/g, ' ')],
          requiresConfirmation: tool.id !== 'git-safe',
        },
      });

      this.registry.register(definition);
      this.loadedTools.set(tool.id, tool);
    });

    console.log('[ToolManager] System tools registered');
  }

  /**
   * Create tool definition with defaults
   */
  normalizeSkillTriggerPatterns(values = []) {
    return Array.from(new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value || '')
          .trim()
          .toLowerCase()
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' '))
        .filter(Boolean),
    ));
  }

  inferToolRequiresConfirmation(tool) {
    const sideEffects = new Set(
      Array.isArray(tool?.sideEffects)
        ? tool.sideEffects.map((effect) => String(effect || '').toLowerCase())
        : [],
    );
    const category = String(tool?.category || '').toLowerCase();

    return sideEffects.has('write')
      || sideEffects.has('execute')
      || category === 'ssh'
      || category === 'database';
  }

  createToolDefinition(tool, overrides = {}) {
    const base = tool.toDefinition();
    const defaultTriggerPatterns = this.normalizeSkillTriggerPatterns([
      tool.name,
      tool.id,
      tool.id ? tool.id.replace(/[-_]+/g, ' ') : '',
    ]);
    
    return {
      ...base,
      skill: {
        triggerPatterns: defaultTriggerPatterns,
        autoApply: false,
        requiresConfirmation: this.inferToolRequiresConfirmation(tool),
        ...overrides.skill
      },
      frontend: {
        exposeToFrontend: true,
        icon: 'tool',
        ...overrides.frontend
      }
    };
  }

  /**
   * Get trigger patterns for SSH tools
   */
  getSSHTriggerPatterns(toolId) {
    const patterns = {
      'ssh-execute': [
        'ssh',
        'bash',
        'shell',
        'remote command',
        'execute on server',
        'run on host',
        'run bash remotely',
      ],
      'remote-command': [
        'remote cli',
        'remote cli runner',
        'remote cli workbench',
        'direct cli',
        'direct remote cli',
        'remote command',
        'run remotely',
        'execute remotely',
        'ssh',
        'kubectl',
        'k3s',
        'k8s',
        'rancher',
        'journalctl',
        'systemctl',
        'ingress',
        'deployment logs',
      ],
      'remote-workbench': [
        'remote workbench',
        'remote repo status',
        'remote git prepare',
        'remote git snapshot',
        'remote git commit',
        'remote git revert',
        'remote diff',
        'remote file read',
        'remote file write',
        'remote apply patch',
        'remote grep',
        'remote build',
        'remote test',
        'remote logs',
        'remote rollout',
        'remote verify',
      ],
      'remote-cli-agent': [
        'remote cli agent',
        'remote code run',
        'remote_code_run',
        'remote code status',
        'remote coding agent',
        'agents sdk remote cli',
        'streamable http mcp',
        'mcp remote cli',
        'build on remote server',
        'deploy on remote server',
        'deploy app remotely',
        'remote software deployment',
        'remote website deployment',
        'remote app deployment',
        'admin runner deployment',
        'remote server coding task',
      ],
      'docker-exec': ['docker', 'container', 'run in container', 'docker exec'],
      'k3s-deploy': [
        'k3s deploy',
        'deploy to k3s',
        'kubectl apply',
        'rollout status',
        'set image',
        'sync repo to cluster',
        'apply manifests',
        'cluster rollout',
      ],
    };
    return patterns[toolId] || [toolId];
  }

  /**
   * Set up event listeners
   */
  setupEventListeners() {
    // Listen for tool invocations
    this.registry.on('tool:registered', ({ id }) => {
      console.log(`[ToolManager] Tool registered: ${id}`);
    });

    // Listen for skill updates
    this.registry.on('skill:updated', ({ id, skill }) => {
      console.log(`[ToolManager] Skill updated: ${id} (enabled: ${skill.enabled})`);
    });
  }

  /**
   * Get a tool instance
   */
  getTool(id) {
    return this.loadedTools.get(id) || this.registry.getTool(id);
  }

  refreshToolReadiness(ids = null) {
    const toolIds = Array.isArray(ids) && ids.length > 0
      ? ids
      : Array.from(new Set([
        ...this.registry.getAllTools().map((tool) => tool.id),
        ...this.loadedTools.keys(),
      ]));
    return toolIds.map((id) => this.registry.refreshToolReadiness(id, this.getTool(id)));
  }

  getToolReadiness(id) {
    return this.registry.refreshToolReadiness(id, this.getTool(id));
  }

  getToolReadinessSummary(ids = null) {
    const toolIds = Array.isArray(ids) && ids.length > 0
      ? ids
      : Array.from(new Set([
        ...this.registry.getAllTools().map((tool) => tool.id),
        ...this.loadedTools.keys(),
      ]));
    return toolIds.map((id) => summarizeToolReadiness(this.getToolReadiness(id)));
  }

  getToolContract(id) {
    const tool = this.getTool(id);
    return tool ? buildToolContract(id, tool) : null;
  }

  validateToolCall(id, params = {}, options = {}) {
    return validatePlanStep({
      tool: id,
      params,
    }, {
      toolManager: this,
      contracts: {
        [id]: this.getToolContract(id),
      },
      allowUnsupportedManagedApp: true,
      ...options,
    });
  }

  /**
   * Execute a tool
   */
  async executeTool(id, params, context = {}) {
    const tool = this.getTool(id);
    
    if (!tool) {
      throw new Error(`Tool not found: ${id}`);
    }

    // Check if skill is enabled
    const skill = this.registry.getSkill(id);
    if (skill && !skill.enabled) {
      throw new Error(`Tool ${id} is disabled`);
    }

    const readiness = this.getToolReadiness(id);
    if (readiness.status === READINESS_UNAVAILABLE
      || (readiness.status === READINESS_DEGRADED && readiness.executableShape === 'none')) {
      const error = new Error(`Tool ${id} is unavailable: ${readiness.reason}`);
      error.code = 'TOOL_UNAVAILABLE';
      error.readiness = readiness;
      throw error;
    }

    const normalizedParams = id === 'file-write'
      ? normalizeFileWriteParams(params)
      : params;
    const effectiveContext = context?.toolManager
      ? context
      : { ...context, toolManager: this };
    if (effectiveContext.validateToolPlan === true || process.env.ORCHESTRATION_REWRITE_ENABLED === 'true') {
      const validation = this.validateToolCall(id, normalizedParams);
      if (!validation.ok) {
        const error = new Error(`Invalid tool call for ${id}: ${validation.rejections.map((rejection) => rejection.message).join('; ')}`);
        error.code = 'INVALID_TOOL_CALL';
        error.validation = validation;
        throw error;
      }
    }

    // Execute either a ToolBase instance or a registry definition.
    let result;
    if (typeof tool.execute === 'function') {
      const startedAt = Date.now();
      try {
        result = await tool.execute(normalizedParams, effectiveContext);
      } catch (error) {
        result = {
          success: false,
          error: error.message,
          ...(error?.code ? { errorCode: error.code } : {}),
          duration: Date.now() - startedAt,
          toolId: id,
          timestamp: new Date().toISOString(),
        };
      }
    } else if (typeof tool.backend?.handler === 'function') {
      const startedAt = Date.now();
      try {
        const data = await tool.backend.handler(normalizedParams, effectiveContext);
        result = {
          success: true,
          data,
          duration: Date.now() - startedAt,
          toolId: id,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        const diagnostics = id === 'image-generate'
          ? {
              imageGeneration: buildImageGenerationDiagnostics({
                route: 'agent-tool:image-generate',
                stage: 'tool_error',
                source: 'agent-tool',
                requestedCount: Math.min(Math.max(Number(normalizedParams?.n) || 1, 1), 5),
                model: normalizedParams?.model || null,
                size: normalizedParams?.size || 'auto',
                quality: normalizedParams?.quality || 'auto',
                prompt: normalizedParams?.prompt || '',
                error,
              }),
            }
          : id === 'podcast'
            ? {
                podcast: {
                  stage: error?.podcastStage || error?.podcastDiagnostics?.stage || 'tool-handler',
                  code: error?.code || null,
                  statusCode: error?.statusCode || error?.status || null,
                  ...(error?.podcastDiagnostics || {}),
                },
              }
          : null;
        if (id === 'podcast') {
          console.error('[ToolManager] Podcast tool failed', {
            stage: diagnostics?.podcast?.stage || 'tool-handler',
            code: error?.code || null,
            statusCode: error?.statusCode || error?.status || null,
            message: error.message,
          });
        }
        result = {
          success: false,
          error: error.message,
          ...(error?.code ? { errorCode: error.code } : {}),
          ...(Number.isFinite(Number(error?.statusCode || error?.status)) ? { statusCode: Number(error.statusCode || error.status) } : {}),
          duration: Date.now() - startedAt,
          toolId: id,
          timestamp: new Date().toISOString(),
          ...(diagnostics ? { diagnostics } : {}),
        };
      }
    } else {
      throw new Error(`Tool ${id} has no executable handler`);
    }

    const failureKind = result?.success === false
      ? classifyFailureText([
          result?.error,
          result?.errorCode,
          result?.diagnostics ? JSON.stringify(result.diagnostics) : '',
        ].filter(Boolean).join('\n'))
      : null;
    result = {
      ...(result || {}),
      toolId: result?.toolId || id,
      readiness: summarizeToolReadiness(readiness),
      verification: {
        status: result?.success === false ? 'failed' : 'observed',
        evidence: result?.success === false
          ? 'Tool returned an error result.'
          : 'Tool returned a structured result.',
      },
      ...(failureKind ? { failureKind } : {}),
    };

    this.registry.setToolReadiness(id, {
      status: result.success === false && failureKind === 'unavailable_tool'
        ? READINESS_DEGRADED
        : READINESS_READY,
      reason: result.success === false
        ? `Last execution failed: ${result.error || failureKind}`
        : 'Last execution completed.',
      lastProbe: {
        success: result.success !== false,
        failureKind,
        timestamp: result.timestamp || new Date().toISOString(),
      },
    });
    
    // Record stats
    this.registry.recordInvocation(id, result, {
      ...effectiveContext,
      params: normalizedParams,
    });
    
    return result;
  }

  /**
   * Get all available tools for frontend
   */
  getFrontendTools() {
    return this.registry.getFrontendTools();
  }

  /**
   * Get all skills for admin
   */
  getAdminSkills() {
    return this.registry.getAllSkills();
  }

  /**
   * Get registry stats
   */
  getStats() {
    return {
      tools: this.registry.getAllTools().length,
      skills: this.registry.getAllSkills().length,
      categories: this.registry.getCategories(),
      byCategory: this.registry.getCategories().map(cat => ({
        name: cat,
        count: this.registry.getToolsByCategory(cat).length
      }))
    };
  }
}

// Singleton
let instance = null;

function getToolManager() {
  if (!instance) {
    instance = new ToolManager();
  }
  return instance;
}

module.exports = { ToolManager, getToolManager };

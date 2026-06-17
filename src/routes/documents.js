/**
 * Document Creation Routes
 * API endpoints for template-based, AI-powered, and assembly document generation
 */

const { Router } = require('express');
const { sessionStore } = require('../session-store');
const { artifactService } = require('../artifacts/artifact-service');
const { inferFormat, normalizeFormat } = require('../artifacts/constants');
const { validate } = require('../middleware/validate');
const { stripHtml } = require('../utils/text');

const router = Router();

// Validation schemas
const generateSchema = {
  sessionId: { required: false, type: 'string' },
  templateId: { required: true, type: 'string' },
  variables: { required: true, type: 'object' },
  format: { required: true, type: 'string' },
  options: { required: false, type: 'object' }
};

const aiGenerateSchema = {
  sessionId: { required: false, type: 'string' },
  prompt: { required: true, type: 'string' },
  documentType: { required: false, type: 'string' },
  intent: { required: false, type: 'string' },
  useCase: { required: false, type: 'string' },
  packId: { required: false, type: 'string' },
  tone: { required: false, type: 'string' },
  length: { required: false, type: 'string' },
  style: { required: false, type: 'string' },
  format: { required: false, type: 'string' },
  options: { required: false, type: 'object' },
  model: { required: false, type: 'string' },
  qualityPass: { required: false, type: 'boolean' },
  disableQualityPass: { required: false, type: 'boolean' },
  qualityModel: { required: false, type: 'string' },
  qualityReasoningEffort: { required: false, type: 'string' },
  designOptionId: { required: false, type: 'string' },
  templateId: { required: false, type: 'string' },
  templateIds: { required: false, type: 'array' },
  templateVariables: { required: false, type: 'object' }
};

const recommendSchema = {
  prompt: { required: false, type: 'string' },
  documentType: { required: false, type: 'string' },
  intent: { required: false, type: 'string' },
  useCase: { required: false, type: 'string' },
  packId: { required: false, type: 'string' },
  format: { required: false, type: 'string' },
  limit: { required: false, type: 'number' }
};

const planSchema = {
  prompt: { required: false, type: 'string' },
  documentType: { required: false, type: 'string' },
  intent: { required: false, type: 'string' },
  useCase: { required: false, type: 'string' },
  packId: { required: false, type: 'string' },
  format: { required: false, type: 'string' },
  tone: { required: false, type: 'string' },
  length: { required: false, type: 'string' },
  style: { required: false, type: 'string' },
  designOptionId: { required: false, type: 'string' },
  limit: { required: false, type: 'number' }
};

const expandOutlineSchema = {
  sessionId: { required: false, type: 'string' },
  outline: { required: true, type: 'array' },
  title: { required: false, type: 'string' },
  tone: { required: false, type: 'string' },
  length: { required: false, type: 'string' },
  format: { required: false, type: 'string' },
  options: { required: false, type: 'object' },
  model: { required: false, type: 'string' }
};

const dataGenerateSchema = {
  sessionId: { required: false, type: 'string' },
  data: { required: true, type: 'object' },
  templateId: { required: true, type: 'string' },
  format: { required: false, type: 'string' },
  options: { required: false, type: 'object' }
};

const assembleSchema = {
  sessionId: { required: false, type: 'string' },
  sources: { required: true, type: 'array' },
  format: { required: true, type: 'string' },
  options: { required: false, type: 'object' }
};

const convertSchema = {
  documentId: { required: true, type: 'string' },
  toFormat: { required: true, type: 'string' }
};

const exportNotesPagePdfSchema = {
  page: { required: true, type: 'object' },
  options: { required: false, type: 'object' }
};

function getRequestOwnerId(req) {
  return String(req.user?.username || '').trim() || null;
}

function normalizeRequestedSessionId(value = '') {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeDocumentCreationFormat(format = 'html') {
  const normalized = String(format || 'html').trim().toLowerCase();
  if (!normalized || normalized === 'docx' || normalized === 'doc' || normalized === 'word') {
    return 'html';
  }
  if (normalized === 'markdown') {
    return 'md';
  }
  return normalized;
}

function setPersistedArtifactHeaders(res, artifact = null) {
  if (!artifact) {
    return;
  }

  res.setHeader('X-Artifact-Id', artifact.id || '');
  res.setHeader('X-Artifact-Filename', artifact.filename || '');
  res.setHeader('X-Artifact-Format', artifact.format || artifact.metadata?.format || '');
  res.setHeader('X-Artifact-Mime-Type', artifact.mimeType || '');
  res.setHeader('X-Artifact-Download-Url', artifact.downloadUrl || '');
  res.setHeader('X-Artifact-Preview-Url', artifact.previewUrl || '');
  res.setHeader('X-Artifact-Session-Id', artifact.sessionId || '');
  res.setHeader('X-Artifact-Size-Bytes', String(artifact.sizeBytes || artifact.size || 0));
}

function applyInlineDocumentResponseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Origin-Agent-Cluster', '?0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function normalizeDocumentContentBuffer(document = null) {
  if (Buffer.isBuffer(document?.contentBuffer)) {
    return document.contentBuffer;
  }

  if (Buffer.isBuffer(document?.content)) {
    return document.content;
  }

  if (typeof document?.content === 'string') {
    return Buffer.from(document.content, 'utf8');
  }

  return null;
}

function getGeneratedDocumentContentBuffer(document = null) {
  const contentBuffer = normalizeDocumentContentBuffer(document);
  if (contentBuffer) {
    return contentBuffer;
  }

  const error = new Error(`Generated document content is no longer available: ${document?.id || 'unknown'}`);
  error.statusCode = 410;
  throw error;
}

function isInlineDocumentRequest(req) {
  const inlineValue = String(req.query?.inline || '').trim().toLowerCase();
  return ['1', 'true', 'yes'].includes(inlineValue);
}

function buildContentDisposition(disposition = 'attachment', filename = 'document') {
  const safeDisposition = disposition === 'inline' ? 'inline' : 'attachment';
  const safeFilename = String(filename || 'document').replace(/["\r\n]/g, '');
  return `${safeDisposition}; filename="${safeFilename || 'document'}"`;
}

function isSafeHeaderValue(value = '') {
  return /^[\x09\x20-\x7e]*$/.test(String(value || ''));
}

function setDocumentMetadataHeaders(res, metadata = {}) {
  let json = '{}';
  try {
    json = JSON.stringify(metadata || {}) || '{}';
  } catch (_error) {
    json = '{}';
  }

  const canSendRawMetadata = json.length <= 4096 && isSafeHeaderValue(json);
  res.setHeader('X-Document-Metadata', canSendRawMetadata ? json : '{}');

  if (!canSendRawMetadata && Buffer.byteLength(json, 'utf8') <= 8192) {
    res.setHeader('X-Document-Metadata-Base64', Buffer.from(json, 'utf8').toString('base64'));
  } else if (!canSendRawMetadata) {
    res.setHeader('X-Document-Metadata-Truncated', 'true');
  }
}

function resolveDocumentPreviewHtml(document = null) {
  if (typeof document?.previewHtml === 'string' && document.previewHtml.trim()) {
    return document.previewHtml;
  }

  const preview = document?.preview && typeof document.preview === 'object' && !Array.isArray(document.preview)
    ? document.preview
    : null;
  if (preview?.type === 'html' && typeof preview.content === 'string' && preview.content.trim()) {
    return preview.content;
  }

  return '';
}

function resolveDocumentExtractedText(document = null, previewHtml = '') {
  if (typeof document?.extractedText === 'string' && document.extractedText.trim()) {
    return document.extractedText;
  }

  if (previewHtml) {
    return stripHtml(previewHtml);
  }

  if (typeof document?.contentPreview === 'string' && document.contentPreview.trim()) {
    return document.contentPreview;
  }

  return '';
}

function normalizeTemplateIds(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return String(value || '').trim() ? [String(value).trim()] : [];
  }

  return [];
}

function serializeArtifactAsDocument(artifact = null) {
  const metadata = artifact?.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
    ? artifact.metadata
    : {};

  return {
    id: artifact?.id || '',
    filename: artifact?.filename || 'document.html',
    mimeType: artifact?.mimeType || 'text/html',
    size: Number(artifact?.sizeBytes || 0),
    sizeBytes: Number(artifact?.sizeBytes || 0),
    format: artifact?.format || metadata.format || 'html',
    sessionId: artifact?.sessionId || '',
    metadata: {
      generatedAt: new Date().toISOString(),
      aiGenerated: true,
      format: artifact?.format || metadata.format || 'html',
      ...metadata,
    },
    preview: artifact?.preview || null,
    downloadUrl: artifact?.downloadUrl || null,
    previewUrl: artifact?.previewUrl || null,
    sandboxUrl: artifact?.sandboxUrl || null,
  };
}

async function maybePersistDocumentArtifact(req, document = null, sessionId = null, sourceMode = 'document') {
  const normalizedSessionId = normalizeRequestedSessionId(sessionId);
  if (!normalizedSessionId || !document) {
    return null;
  }

  const runtimeArtifactService = req.app.locals.artifactService || artifactService;
  if (typeof runtimeArtifactService?.createStoredArtifact !== 'function'
    || typeof runtimeArtifactService?.serializeArtifact !== 'function') {
    return null;
  }

  const ownerId = getRequestOwnerId(req);
  const session = ownerId
    ? await sessionStore.getOwned(normalizedSessionId, ownerId)
    : await sessionStore.get(normalizedSessionId);
  if (!session) {
    return null;
  }

  const buffer = normalizeDocumentContentBuffer(document);
  if (!buffer) {
    return null;
  }

  const format = normalizeFormat(
    document?.metadata?.format
    || inferFormat(document?.filename, document?.mimeType)
    || '',
  );
  if (!format) {
    return null;
  }

  const previewHtml = resolveDocumentPreviewHtml(document);
  const extractedText = resolveDocumentExtractedText(document, previewHtml);
  try {
    const storedArtifact = await runtimeArtifactService.createStoredArtifact({
      sessionId: normalizedSessionId,
      session,
      direction: 'generated',
      sourceMode,
      filename: document.filename || `document.${format}`,
      extension: format,
      mimeType: document.mimeType || 'application/octet-stream',
      buffer,
      extractedText,
      previewHtml,
      metadata: {
        ...(document?.metadata || {}),
        originalDocumentId: document?.id || null,
        originalDownloadUrl: document?.downloadUrl || null,
        persistedFrom: 'documents-route',
      },
      vectorize: Boolean(extractedText),
    });

    return runtimeArtifactService.serializeArtifact(storedArtifact);
  } catch (error) {
    console.warn(`[Documents] Failed to persist generated document as artifact: ${error.message}`);
    return null;
  }
}

async function buildDocumentTemplateSelection(templateStore, {
  prompt = '',
  documentType = '',
  templateId = null,
  templateIds = [],
  templateVariables = {},
} = {}) {
  if (!templateStore) {
    return { matches: [], context: '' };
  }

  const explicitTemplateIds = [
    ...normalizeTemplateIds(templateId),
    ...normalizeTemplateIds(templateIds),
  ];
  const selection = templateStore.buildPromptContext({
    explicitTemplateIds,
    query: [prompt, documentType].filter(Boolean).join('\n'),
    surface: 'document',
    kind: 'document',
    limit: explicitTemplateIds.length > 0 ? 4 : 3,
    variables: templateVariables,
  });

  if (selection.matches.length > 0) {
    await templateStore.noteTemplateUse(selection.matches.map((template) => template.id));
  }

  return selection;
}

/**
 * GET /api/documents/templates
 * List all available templates
 */
router.get('/templates', async (req, res, next) => {
  try {
    const {
      category = '',
      packId = '',
      useCase = '',
      intent = '',
      format = '',
      limit,
    } = req.query;
    const documentService = req.app.locals.documentService;
    const requestedFormat = format ? normalizeDocumentCreationFormat(format) : '';

    const templates = await documentService.getTemplates({
      category,
      packId,
      useCase,
      intent,
      format: requestedFormat,
      limit,
    });

    const simplified = templates.map((template) => ({
      ...documentService.buildTemplateMetadata(template),
      tags: template.tags,
      recommendedFormats: documentService.getTemplateAvailableFormats(template),
    }));

    res.json({
      templates: simplified,
      packs: documentService.summarizePackSuggestions(templates, { limit: 12 }),
      categories: documentService.templateEngine.getCategories(),
      count: simplified.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/documents/blueprints
 * List document production blueprints
 */
router.get('/blueprints', async (req, res, next) => {
  try {
    const documentService = req.app.locals.documentService;
    const blueprints = documentService.getBlueprints();

    res.json({
      blueprints,
      count: blueprints.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/documents/templates/:id
 * Get specific template details
 */
router.get('/templates/:id', async (req, res, next) => {
  try {
    const documentService = req.app.locals.documentService;
    const template = await documentService.getTemplate(req.params.id);
    
    if (!template) {
      return res.status(404).json({ 
        error: { message: `Template not found: ${req.params.id}` } 
      });
    }
    
    res.json({
      template: {
        ...documentService.buildTemplateMetadata(template),
        tags: template.tags,
        recommendedFormats: documentService.getTemplateAvailableFormats(template),
        variables: template.variables,
        aiEnhancement: template.aiEnhancement,
        productionProfile: template.productionProfile || null,
        variants: template.variants,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/documents/templates/:id/defaults
 * Get default variable values for a template
 */
router.get('/templates/:id/defaults', async (req, res, next) => {
  try {
    const documentService = req.app.locals.documentService;
    const template = documentService.templateEngine.getTemplate(req.params.id);
    
    if (!template) {
      return res.status(404).json({ 
        error: { message: `Template not found: ${req.params.id}` } 
      });
    }
    
    const defaults = documentService.templateEngine.getDefaultVariables(req.params.id);
    
    res.json({
      templateId: req.params.id,
      defaults
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/documents/formats
 * List supported document formats
 */
router.get('/formats', (req, res) => {
  const documentService = req.app.locals.documentService;
  
  res.json({
    formats: documentService.getSupportedFormats(),
    productionCapabilities: typeof documentService.getDocumentProductionCapabilities === 'function'
      ? documentService.getDocumentProductionCapabilities()
      : null,
  });
});

/**
 * POST /api/documents/recommend
 * Recommend blueprint, workflow, format, and templates for a document request
 */
router.post('/recommend', validate(recommendSchema), async (req, res, next) => {
  try {
    const documentService = req.app.locals.documentService;
    const body = req.body || {};
    const recommendation = documentService.recommendDocumentWorkflow({
      ...body,
      format: body.format ? normalizeDocumentCreationFormat(body.format) : '',
    });

    res.json({
      success: true,
      recommendation,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/plan
 * Build a deterministic document-production plan for the current request
 */
router.post('/plan', validate(planSchema), async (req, res, next) => {
  try {
    const documentService = req.app.locals.documentService;
    const body = req.body || {};
    const plan = documentService.buildDocumentPlan({
      ...body,
      format: body.format ? normalizeDocumentCreationFormat(body.format) : '',
      theme: body.style || body.theme || '',
      designOptionId: body.designOptionId || '',
    });

    res.json({
      success: true,
      plan,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/generate
 * Generate document from template
 */
router.post('/generate', validate(generateSchema), async (req, res, next) => {
  try {
    const { sessionId = null, templateId, variables, format, options = {} } = req.body;
    const documentService = req.app.locals.documentService;
    const requestedFormat = normalizeDocumentCreationFormat(format);
    
    let document = await documentService.generateFromTemplate(
      templateId, 
      variables, 
      requestedFormat, 
      options
    );
    const persistedArtifact = await maybePersistDocumentArtifact(req, document, sessionId, 'document-template');
    if (persistedArtifact) {
      document = {
        ...document,
        id: persistedArtifact.id,
        filename: persistedArtifact.filename,
        mimeType: persistedArtifact.mimeType,
        downloadUrl: persistedArtifact.downloadUrl,
      };
    }
    const contentBuffer = getGeneratedDocumentContentBuffer(document);
    
    // Set appropriate headers
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
    res.setHeader('X-Document-Id', document.id);
    setDocumentMetadataHeaders(res, document.metadata);
    setPersistedArtifactHeaders(res, persistedArtifact);
    
    res.send(contentBuffer);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/ai-generate
 * Generate document using AI
 */
router.post('/ai-generate', validate(aiGenerateSchema), async (req, res, next) => {
  try {
    const {
      sessionId = null,
      prompt,
      documentType,
      intent = '',
      useCase = '',
      packId = '',
      tone = 'professional',
      length = 'medium',
      style = '',
      format = 'html',
      options = {},
      model,
      qualityPass,
      disableQualityPass,
      qualityModel,
      qualityReasoningEffort,
      designOptionId = '',
      templateId = null,
      templateIds = [],
      templateVariables = {},
    } = req.body;

    const documentService = req.app.locals.documentService;
    const requestedFormat = normalizeDocumentCreationFormat(format);
    const templateSelection = await buildDocumentTemplateSelection(req.app.locals.templateStore, {
      prompt,
      documentType,
      templateId,
      templateIds,
      templateVariables,
    });
    const productionPlan = documentService.buildDocumentPlan({
      prompt,
      documentType,
      intent,
      useCase,
      packId,
      format: requestedFormat,
      tone,
      length,
      theme: style || options.theme || options.style || '',
      designOptionId: designOptionId || options.designOptionId || '',
    });

    let document = await documentService.aiGenerate(prompt, {
      documentType,
      intent,
      useCase,
      packId,
      tone,
      length,
      format: requestedFormat,
      style,
      model,
      qualityPass,
      disableQualityPass,
      qualityModel,
      qualityReasoningEffort,
      designOptionId: designOptionId || options.designOptionId || '',
      designPlan: productionPlan,
      templateContext: templateSelection.context,
      ...options,
    });
    const persistedArtifact = await maybePersistDocumentArtifact(req, document, sessionId, 'document-ai');
    const downloadUrl = persistedArtifact
      ? persistedArtifact.downloadUrl
      : `/api/documents/${document.id}/download`;
    if (persistedArtifact) {
      document = serializeArtifactAsDocument(persistedArtifact);
    }

    res.json({
      success: true,
      document: {
        id: document.id,
        filename: document.filename,
        mimeType: document.mimeType,
        size: document.size,
        sizeBytes: document.sizeBytes || document.size || 0,
        format: document.format || document.metadata?.format || requestedFormat,
        sessionId: document.sessionId || sessionId || '',
        metadata: document.metadata,
        preview: document.preview,
        downloadUrl,
        previewUrl: document.previewUrl || null,
        sandboxUrl: document.sandboxUrl || null,
      },
      artifact: persistedArtifact || null,
      productionPlan,
      templateMatches: templateSelection.matches,
      downloadUrl,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/expand-outline
 * Expand an outline into a full document
 */
router.post('/expand-outline', validate(expandOutlineSchema), async (req, res, next) => {
  try {
    const {
      sessionId = null,
      outline,
      title,
      tone = 'professional',
      length = 'medium',
      format = 'html',
      options = {},
      model
    } = req.body;
    
    const documentService = req.app.locals.documentService;
    const requestedFormat = normalizeDocumentCreationFormat(format);
    
    let document = await documentService.expandOutline(outline, {
      title,
      tone,
      length,
      format: requestedFormat,
      model,
      ...options
    });
    const persistedArtifact = await maybePersistDocumentArtifact(req, document, sessionId, 'document-outline');
    const downloadUrl = persistedArtifact
      ? persistedArtifact.downloadUrl
      : `/api/documents/${document.id}/download`;
    if (persistedArtifact) {
      document = serializeArtifactAsDocument(persistedArtifact);
    }
    
    res.json({
      success: true,
      document: {
        id: document.id,
        filename: document.filename,
        mimeType: document.mimeType,
        size: document.size,
        sizeBytes: document.sizeBytes || document.size || 0,
        format: document.format || document.metadata?.format || requestedFormat,
        sessionId: document.sessionId || sessionId || '',
        metadata: document.metadata
      },
      artifact: persistedArtifact || null,
      downloadUrl
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/generate-from-data
 * Generate document from structured data
 */
router.post('/generate-from-data', validate(dataGenerateSchema), async (req, res, next) => {
  try {
    const { sessionId = null, data, templateId, format = 'html', options = {} } = req.body;
    const documentService = req.app.locals.documentService;
    const requestedFormat = normalizeDocumentCreationFormat(format);
    
    let document = await documentService.generateFromData(
      data,
      templateId,
      requestedFormat
    );
    const persistedArtifact = await maybePersistDocumentArtifact(req, document, sessionId, 'document-data');
    if (persistedArtifact) {
      document = {
        ...document,
        id: persistedArtifact.id,
        filename: persistedArtifact.filename,
        mimeType: persistedArtifact.mimeType,
        downloadUrl: persistedArtifact.downloadUrl,
      };
    }
    const contentBuffer = getGeneratedDocumentContentBuffer(document);
    
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
    res.setHeader('X-Document-Id', document.id);
    setPersistedArtifactHeaders(res, persistedArtifact);
    
    res.send(contentBuffer);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/assemble
 * Assemble document from multiple sources
 */
router.post('/assemble', validate(assembleSchema), async (req, res, next) => {
  try {
    const { sessionId = null, sources, format, options = {} } = req.body;
    const documentService = req.app.locals.documentService;
    const requestedFormat = normalizeDocumentCreationFormat(format);
    
    let document = await documentService.assemble(sources, {
      format: requestedFormat,
      ...options
    });
    const persistedArtifact = await maybePersistDocumentArtifact(req, document, sessionId, 'document-assemble');
    if (persistedArtifact) {
      document = {
        ...document,
        id: persistedArtifact.id,
        filename: persistedArtifact.filename,
        mimeType: persistedArtifact.mimeType,
        downloadUrl: persistedArtifact.downloadUrl,
      };
    }
    const contentBuffer = getGeneratedDocumentContentBuffer(document);
    
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
    res.setHeader('X-Document-Id', document.id);
    setPersistedArtifactHeaders(res, persistedArtifact);
    
    res.send(contentBuffer);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/convert
 * Convert document between formats
 */
router.post('/convert', validate(convertSchema), async (req, res, next) => {
  try {
    const { documentId, toFormat } = req.body;

    const documentService = req.app.locals.documentService;
    if (typeof documentService?.convertStoredDocument !== 'function') {
      return res.status(503).json({
        error: { message: 'Document conversion is not available' }
      });
    }

    const requestedFormat = normalizeDocumentCreationFormat(toFormat);
    const document = await documentService.convertStoredDocument(documentId, requestedFormat);

    res.json({
      success: true,
      document: {
        id: document.id,
        filename: document.filename,
        mimeType: document.mimeType,
        size: document.size,
        sizeBytes: document.sizeBytes || document.size || 0,
        format: document.format || document.metadata?.format || requestedFormat,
        metadata: document.metadata,
        preview: document.preview || null,
        downloadUrl: document.downloadUrl || `/api/documents/${document.id}/download`,
      },
      downloadUrl: document.downloadUrl || `/api/documents/${document.id}/download`,
    });
  } catch (err) {
    if (err?.statusCode === 404) {
      return res.status(404).json({
        error: { message: err.message }
      });
    }
    next(err);
  }
});

/**
 * POST /api/documents/presentation
 * Generate a presentation with optional AI images
 */
router.post('/presentation', async (req, res, next) => {
  try {
    const {
      sessionId = null,
      content,
      outline,
      title,
      subtitle,
      format = 'pptx',
      slideCount,
      audience,
      style,
      generateImages = true,
      theme = 'default',
      model,
      templateId = null,
      templateIds = [],
      templateVariables = {},
    } = req.body;

    const documentService = req.app.locals.documentService;
    
    // Use outline or content
    const presentationContent = outline || content;
    
    if (!presentationContent) {
      return res.status(400).json({
        error: { message: 'Either content or outline is required' },
      });
    }
    const templateSelection = await buildDocumentTemplateSelection(req.app.locals.templateStore, {
      prompt: typeof presentationContent === 'string' ? presentationContent : title,
      documentType: 'presentation',
      templateId,
      templateIds,
      templateVariables,
    });

    let document = await documentService.generatePresentation(presentationContent, {
      title,
      subtitle,
      format,
      slideCount,
      audience,
      style,
      generateImages,
      theme,
      model,
      templateContext: templateSelection.context,
    });
    const persistedArtifact = await maybePersistDocumentArtifact(req, document, sessionId, 'document-presentation');
    if (persistedArtifact) {
      document = {
        ...document,
        id: persistedArtifact.id,
        filename: persistedArtifact.filename,
        mimeType: persistedArtifact.mimeType,
        downloadUrl: persistedArtifact.downloadUrl,
      };
    }
    const contentBuffer = getGeneratedDocumentContentBuffer(document);

    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
    res.setHeader('X-Document-Id', document.id);
    res.setHeader('X-Slide-Count', document.metadata.slideCount);
    setPersistedArtifactHeaders(res, persistedArtifact);
    
    res.send(contentBuffer);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/preview
 * Generate document preview (metadata and first page)
 */
router.post('/preview', async (req, res, next) => {
  try {
    const { templateId, variables } = req.body;
    const documentService = req.app.locals.documentService;
    
    // Generate document in memory
    const document = await documentService.generateFromTemplate(
      templateId,
      variables,
      'html', // Use HTML for preview
      { includePageNumbers: false }
    );
    
    // Extract preview (first 1000 characters of HTML)
    const content = document.content.toString('utf-8');
    const preview = content.substring(0, 2000);
    
    res.json({
      preview,
      metadata: document.metadata
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/export-notes-page-pdf
 * Render a Notes page object into a styled PDF document
 */
router.post('/export-notes-page-pdf', validate(exportNotesPagePdfSchema), async (req, res, next) => {
  try {
    const { page, options = {} } = req.body;
    const documentService = req.app.locals.documentService;
    const pdfGenerator = documentService?.generators?.pdf;

    if (!pdfGenerator?.generateFromNotesPage) {
      return res.status(503).json({
        error: { message: 'Notes PDF export is not available' }
      });
    }

    const document = await pdfGenerator.generateFromNotesPage(page, options);
    const filename = documentService.generateFilename(page?.title || 'notes-export', 'pdf');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Document-Filename', filename);
    setDocumentMetadataHeaders(res, document.metadata);

    res.send(document.buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/documents/:id/download
 * Download a generated document
 */
router.get('/:id/download', async (req, res, next) => {
  try {
    const documentService = req.app.locals.documentService;
    const document = await Promise.resolve(documentService?.getDocument?.(req.params.id));

    if (!document) {
      return res.status(404).json({
        error: { message: `Document not found: ${req.params.id}` }
      });
    }

    const disposition = isInlineDocumentRequest(req) ? 'inline' : 'attachment';
    const contentBuffer = normalizeDocumentContentBuffer(document);
    if (!contentBuffer) {
      return res.status(410).json({
        error: { message: `Document content is no longer available: ${req.params.id}` }
      });
    }

    res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', buildContentDisposition(disposition, document.filename || 'document'));
    res.setHeader('X-Document-Id', document.id);
    setDocumentMetadataHeaders(res, document.metadata);
    if (disposition === 'inline') {
      applyInlineDocumentResponseHeaders(res);
    }

    res.send(contentBuffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

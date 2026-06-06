/**
 * Document Service - Core module for document creation
 * Handles template-based generation, AI-powered generation, and document assembly
 */

const { PdfGenerator } = require('./generators/pdf-generator');
const { PptxGenerator } = require('./generators/pptx-generator');
const { XlsxGenerator } = require('./generators/xlsx-generator');
const { TemplateEngine } = require('./template-engine');
const { AIDocumentGenerator } = require('./ai-document-generator');
const { ensureHtmlDocument, renderPdfViaBrowser } = require('../artifacts/artifact-renderer');
const { createUniqueFilename, normalizeWhitespace, stripHtml } = require('../utils/text');
const {
  BLUEPRINTS,
  normalizeDocumentType,
  resolveDocumentBlueprint,
} = require('./document-design-blueprints');
const {
  buildDocumentDesignPlan,
  buildDocumentBackgroundSpec,
  resolveDocumentTheme,
} = require('./document-design-engine');
const {
  buildDocumentCreativityPacket,
} = require('./document-creativity');
const {
  buildDocumentQualityPlan,
  summarizeDocumentQualityPlan,
} = require('./document-quality');
const { buildSandboxBrowserLibraryInstructions } = require('../sandbox-browser-libraries');
const {
  getDocumentLayoutOptions,
  findDocumentLayout,
} = require('./document-layout-catalog');

const TEMPLATE_PACK_CATALOG = {
  'research-suite': {
    id: 'research-suite',
    label: 'Research suite',
    intent: 'research',
    useCase: 'research',
    formats: ['html', 'pdf', 'md'],
    rationale: 'Evidence-first artifacts with citations, assumptions, and decision-ready synthesis.',
  },
  'html-dashboard': {
    id: 'html-dashboard',
    label: 'HTML dashboard',
    intent: 'dashboard',
    useCase: 'dashboard',
    formats: ['html'],
    rationale: 'Operational, KPI, and funnel dashboard structures for web publishing.',
  },
  'html-publication': {
    id: 'html-publication',
    label: 'HTML publication',
    intent: 'html',
    useCase: 'html',
    formats: ['html'],
    rationale: 'Readable, publish-ready web pages and product-facing content.',
  },
  'pdf-publication': {
    id: 'pdf-publication',
    label: 'PDF publication',
    intent: 'pdf',
    useCase: 'pdf',
    formats: ['pdf'],
    rationale: 'Print-safe whitepaper-grade outputs with structured sections and references.',
  },
  'training-manuals': {
    id: 'training-manuals',
    label: 'Training and Manuals',
    intent: 'training',
    useCase: 'training',
    formats: ['pdf', 'html', 'xlsx', 'md'],
    rationale: 'Instructional packages with learning objectives, module pacing, practice, assessment, and reusable job aids.',
  },
};

const BLUEPRINT_TO_PACK_MAP = {
  'research-note': 'research-suite',
  'research-methodology': 'research-suite',
  'research-literature': 'research-suite',
  'research-brief': 'research-suite',
  'html-dashboard-kpi': 'html-dashboard',
  'html-dashboard-operational': 'html-dashboard',
  'html-dashboard-funnel': 'html-dashboard',
  'html-article': 'html-publication',
  'html-product-page': 'html-publication',
  'html-technical-spec': 'html-publication',
  'pdf-whitepaper': 'pdf-publication',
  'pdf-audit-report': 'pdf-publication',
  'pdf-executive-brief': 'pdf-publication',
  'training-manual': 'training-manuals',
};

function normalizeTemplateFormatList(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizeIntent(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeUseCase(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function safeLimit(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toTitleCase(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  return raw
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function splitIntentTokens(value = '') {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

function normalizeIntentToken(value = '') {
  return String(value || '').trim().toLowerCase();
}

function blueprintIdIntentHints(documentType = '') {
  const normalized = normalizeDocumentType(documentType);

  if (normalized.startsWith('research-')) {
    return 'research';
  }

  if (normalized.startsWith('html-dashboard-')) {
    return 'dashboard';
  }

  if (normalized.startsWith('html-')) {
    return 'html';
  }

  if (normalized.startsWith('pdf-')) {
    return 'pdf';
  }

  if (normalized === 'training-manual') {
    return 'training';
  }

  return '';
}

function resolveTemplatePackHint(template = {}) {
  const explicitPackId = String(template.packId || '').trim();
  const outputIntent = normalizeIntentToken(template.intent || template.outputIntent);
  const packByBlueprint = BLUEPRINT_TO_PACK_MAP[String(template.blueprint || '').trim()];

  if (explicitPackId) {
    return explicitPackId;
  }

  if (packByBlueprint) {
    return packByBlueprint;
  }

  if (outputIntent === 'research') {
    return 'research-suite';
  }

  if (outputIntent === 'dashboard') {
    return 'html-dashboard';
  }

  if (outputIntent === 'html') {
    return 'html-publication';
  }

  if (outputIntent === 'pdf') {
    return 'pdf-publication';
  }

  return 'general';
}

function buildTemplateRationale({ template = {}, blueprint = {}, format = '', intent = '', useCase = '' } = {}) {
  const reasons = [];
  if (template.intent && intent && template.intent.toLowerCase() === intent.toLowerCase()) {
    reasons.push(`Matches ${template.intent} intent.`);
  }

  if (template.useCases && Array.isArray(template.useCases) && useCase) {
    const matching = template.useCases.some((entry) => String(entry || '').toLowerCase().includes(useCase.toLowerCase()));
    if (matching) {
      reasons.push('Matches requested use case.');
    }
  }

  if (template.blueprint && blueprint && template.blueprint === blueprint.id) {
    reasons.push(`Matches ${blueprint.label} blueprint.`);
  }

  if (format) {
    reasons.push(`Supports ${format.toUpperCase()} output.`);
  }

  const packRationale = summarizePackRationale(template.packReason || []);
  if (packRationale && !reasons.length) {
    reasons.push(packRationale);
  }

  return reasons[0] || 'Good fit for this request.';
}

function buildPackLabel(value = '') {
  const labeled = String(value || '').trim();
  return labeled ? toTitleCase(labeled) : 'General Pack';
}

function summarizePackRationale(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 'Balanced coverage for your selected format.';
  }

  return entries
    .slice(0, 2)
    .map((entry) => entry.toLowerCase())
    .join(' + ') || 'Balanced coverage for your selected format.';
}

class DocumentService {
  constructor(openaiClient) {
    this.generators = {
      pdf: new PdfGenerator(),
      pptx: new PptxGenerator(),
      xlsx: new XlsxGenerator(),
    };

    this.templateEngine = new TemplateEngine();
    this.aiGenerator = new AIDocumentGenerator(openaiClient);
    this.documentStore = new Map();
    this.maxStoredDocuments = 100;
  }

  /**
   * Generate a document from a template
   * @param {string} templateId - Template identifier
   * @param {Object} variables - Template variables
   * @param {string} format - Output format (html, pdf, md, pptx, xlsx)
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generated document
   */
  async generateFromTemplate(templateId, variables, format, options = {}) {
    const template = await this.templateEngine.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    const normalizedFormat = this.normalizeCreationFormat(format);
    const formatCompatibility = this.validateTemplateFormatCompatibility(template, normalizedFormat);
    if (!formatCompatibility.supported) {
      throw new Error(formatCompatibility.error);
    }

    const resolvedVariables = {
      ...this.templateEngine.getDefaultVariables(templateId),
      ...(variables || {}),
    };

    const variableValidation = this.templateEngine.validateTemplateVariableRequirements(template, resolvedVariables);
    if (!variableValidation.valid) {
      throw new Error(`Missing required template variables: ${variableValidation.missing.join(', ')}`);
    }

    // Populate template with variables
    const populated = await this.templateEngine.populate(template, resolvedVariables);
    const renderableTemplate = this.buildRenderableTemplate(populated, resolvedVariables);

    // Generate document
    const document = await this.renderDocument({
      format: normalizedFormat,
      template: renderableTemplate,
      title: template.name,
      options,
    });

    return this.storeGeneratedDocument({
      document,
      filename: this.generateFilename(template.name, normalizedFormat),
      metadata: {
        template: templateId,
        format: normalizedFormat,
        generatedAt: new Date().toISOString(),
        ...document.metadata
      },
    });
  }

  /**
   * Generate a document using AI
   * @param {string} prompt - User prompt
   * @param {Object} options - AI generation options
   * @returns {Promise<Object>} Generated document
   */
  async aiGenerate(prompt, options = {}) {
    const format = this.normalizeCreationFormat(options.format || 'html');
    const designPlan = options.designPlan || this.buildDocumentPlan({
      prompt,
      documentType: options.documentType,
      format,
      tone: options.tone || 'professional',
      length: options.length || 'medium',
      theme: options.theme || options.style || '',
      designOptionId: options.designOptionId || '',
    });
    const qualityStandard = summarizeDocumentQualityPlan(
      designPlan?.qualityStandard || buildDocumentQualityPlan({
        documentType: designPlan?.inferredType || options.documentType || 'document',
        format,
        designPlan,
      }),
    );

    if (this.shouldUsePresentationPipeline(options.documentType, format)) {
      return this.generatePresentation(prompt, {
        ...options,
        format,
        designPlan,
      });
    }

    // Generate structured content using AI
    const content = await this.aiGenerator.generate(prompt, {
      ...options,
      designPlan,
    });

    // Generate document from content
    const document = await this.renderDocument({
      format,
      content,
      title: content.title || 'document',
      options: {
        ...options,
        designPlan,
      },
    });

    return this.storeGeneratedDocument({
      document,
      filename: this.generateFilename(content.title || 'document', format),
      metadata: {
        format,
        generatedAt: new Date().toISOString(),
        aiGenerated: true,
        prompt,
        creativeDirectionId: designPlan?.creativeDirection?.id || '',
        creativeDirection: designPlan?.creativeDirection?.label || '',
        themeSuggestion: designPlan?.themeSuggestion || '',
        designOptionId: designPlan?.selectedDesignOption?.id || '',
        designOptionLabel: designPlan?.selectedDesignOption?.label || '',
        qualityStandard,
        designPlan,
        ...content.metadata,
        ...document.metadata
      },
      preview: content.sections?.map((section) => ({
        heading: section.heading,
        preview: `${String(section.content || '').substring(0, 200)}...`
      })),
    });
  }

  /**
   * Expand an outline into a full document using AI
   * @param {Array} outline - Document outline
   * @param {Object} options - Expansion options
   * @returns {Promise<Object>} Generated document
   */
  async expandOutline(outline, options = {}) {
    const format = this.normalizeCreationFormat(options.format || 'html');

    // Expand outline using AI
    const expanded = await this.aiGenerator.expandOutline(outline, options);

    // Convert to document structure
    const content = this.outlineToDocument(expanded, options);

    // Generate document
    const document = await this.renderDocument({
      format,
      content,
      title: content.title || 'document',
      options,
    });

    return this.storeGeneratedDocument({
      document,
      filename: this.generateFilename(content.title || 'document', format),
      metadata: {
        format,
        generatedAt: new Date().toISOString(),
        aiGenerated: true,
        ...document.metadata
      },
    });
  }

  /**
   * Generate document from structured data
   * @param {Object} data - Structured data
   * @param {string} templateId - Template to use
   * @param {string} format - Output format
   * @returns {Promise<Object>} Generated document
   */
  async generateFromData(data, templateId, format) {
    const template = await this.templateEngine.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Flatten nested data for template variables
    const variables = this.flattenData(data);

    return this.generateFromTemplate(templateId, variables, format);
  }

  /**
   * Assemble a document from multiple sources
   * @param {Array} sources - Array of source objects
   * @param {Object} options - Assembly options
   * @returns {Promise<Object>} Assembled document
   */
  async assemble(sources, options = {}) {
    const normalizedSources = this.normalizeAssemblySources(sources);
    if (normalizedSources.length === 0) {
      throw new Error('At least one source with content is required to assemble a document.');
    }

    const format = this.normalizeCreationFormat(options.format || 'html');
    const content = this.buildAssembledDocumentContent(normalizedSources, options);
    const combined = content.sections.map((section) => [
      section.heading,
      section.content,
      Array.isArray(section.bullets) ? section.bullets.join('\n') : '',
    ].filter(Boolean).join('\n')).join('\n\n');

    const document = await this.renderDocument({
      format,
      content,
      title: content.title || options.title || 'document',
      options: {
        ...options,
        documentType: options.documentType || content.documentType || 'report',
      },
      rawText: combined,
    });

    return this.storeGeneratedDocument({
      document,
      filename: this.generateFilename(content.title || options.title || 'document', format),
      metadata: {
        ...(document.metadata || {}),
        format,
        generatedAt: new Date().toISOString(),
        assembled: true,
        sourceCount: normalizedSources.length,
        sources: normalizedSources.map((source) => ({
          id: source.id,
          type: source.type,
          title: source.title,
          sectionCount: source.sections.length,
          textLength: source.textLength,
        })),
      },
    });
  }

  /**
   * Convert a document between formats
   * @param {Buffer} content - Document content
   * @param {string} fromFormat - Source format
   * @param {string} toFormat - Target format
   * @returns {Promise<Object>} Converted document
   */
  async convert(content, fromFormat, toFormat) {
    // This is a simplified conversion - in production, use pandoc or similar
    const sourceGen = this.generators[fromFormat];
    const targetGen = this.generators[toFormat];

    if (!sourceGen || !targetGen) {
      throw new Error('Unsupported format conversion');
    }

    // Extract content structure
    const structure = await sourceGen.extract(content);

    // Generate in target format
    const result = await targetGen.generateFromContent(structure);

    return this.storeDocument({
      id: this.generateId(),
      content: result.buffer || result.content,
      filename: this.generateFilename('converted', toFormat),
      mimeType: targetGen.mimeType,
      metadata: {
        convertedFrom: fromFormat,
        convertedTo: toFormat,
        convertedAt: new Date().toISOString()
      }
    });
  }

  async convertStoredDocument(documentId, toFormat, options = {}) {
    const sourceDocument = this.getDocument(documentId);
    if (!sourceDocument) {
      const error = new Error(`Document not found: ${documentId}`);
      error.statusCode = 404;
      throw error;
    }

    const targetFormat = this.normalizeCreationFormat(toFormat || 'html');
    const sourceFormat = this.inferStoredDocumentFormat(sourceDocument);
    if (!targetFormat) {
      throw new Error('Target document format is required.');
    }

    if (sourceFormat === targetFormat) {
      return sourceDocument;
    }

    const content = this.storedDocumentToContent(sourceDocument, options);
    const document = await this.renderDocument({
      format: targetFormat,
      content,
      title: content.title || 'converted',
      options: {
        ...options,
        documentType: options.documentType || content.documentType || 'document',
      },
      rawText: content.sections.map((section) => `${section.heading}\n${section.content || ''}`).join('\n\n'),
    });

    return this.storeGeneratedDocument({
      document,
      filename: this.generateFilename(content.title || 'converted', targetFormat),
      metadata: {
        ...(document.metadata || {}),
        format: targetFormat,
        convertedFrom: sourceFormat || sourceDocument.mimeType || 'unknown',
        convertedTo: targetFormat,
        sourceDocumentId: sourceDocument.id,
        convertedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Generate a presentation with optional AI images
   * @param {string|Object} content - Presentation content or outline
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generated presentation
   */
  async generatePresentation(content, options = {}) {
    const format = String(options.format || 'pptx').toLowerCase();
    const designPlan = options.designPlan || (typeof content === 'string'
      ? this.buildDocumentPlan({
        prompt: content,
        documentType: options.documentType || 'presentation',
        format,
        tone: options.tone || 'professional',
        length: options.length || 'medium',
        existingContent: options.existingContent || '',
        session: options.session || null,
      })
      : null);

    // Build presentation structure
    let presentationContent;
    if (typeof content === 'string') {
      if (this.looksLikePresentationOutline(content)) {
        presentationContent = this.parsePresentationOutline(content, options);
      } else {
        presentationContent = await this.aiGenerator.generatePresentationContent(content, {
          ...options,
          designPlan,
          slideCount: options.slideCount || this.inferSlideCount(options.length),
        });
      }
    } else if (content.slides) {
      presentationContent = this.aiGenerator.normalizePresentationStructure(content, options);
    } else {
      throw new Error('Invalid presentation content format');
    }

    let document;
    let mimeType;
    let generatedContent;
    const previewDeck = this.renderPresentationDeck(presentationContent, options);
    const previewHtml = String(previewDeck.content || '');
    const extractedText = stripHtml(previewHtml);
    const qualityStandard = typeof presentationContent.metadata?.qualityStandard === 'object'
      ? presentationContent.metadata.qualityStandard
      : summarizeDocumentQualityPlan(
        designPlan?.qualityStandard || buildDocumentQualityPlan({
          documentType: designPlan?.inferredType || options.documentType || 'presentation',
          format,
          designPlan,
        }),
      );

    if (format === 'html') {
      document = this.renderPresentationDeck(presentationContent, options);
      mimeType = document.mimeType;
      generatedContent = document.content;
    } else {
      const generator = this.generators.pptx;
      if (!generator) {
        throw new Error('PPTX generator not available');
      }

      document = await generator.generateFromContent(presentationContent, options);
      mimeType = generator.mimeType;
      generatedContent = document.buffer;
    }

    return this.storeGeneratedDocument({
      document: {
        ...document,
        buffer: generatedContent,
        mimeType,
        preview: previewHtml
          ? { type: 'html', content: previewHtml }
          : null,
        previewHtml,
        extractedText,
      },
      filename: this.generateFilename(presentationContent.title || 'presentation', format),
      metadata: {
        format,
        generatedAt: new Date().toISOString(),
        aiGenerated: typeof content === 'string',
        ...(presentationContent.metadata || {}),
        qualityStandard,
        designPlan,
        slideCount: presentationContent.slides?.length,
        theme: presentationContent.theme || options.theme || 'editorial',
        ...document.metadata
      },
    });
  }

  /**
   * Parse presentation outline into structured content
   * @param {string} outline - Text outline
   * @param {Object} options - Parsing options
   * @returns {Object} Structured presentation content
   */
  parsePresentationOutline(outline, options = {}) {
    const lines = outline.split('\n').map(l => l.trim()).filter(Boolean);
    const slides = [];
    let currentSlide = null;
    let title = options.title || 'Presentation';

    for (const line of lines) {
      // Main title (first level)
      if (line.startsWith('# ')) {
        title = line.substring(2).trim();
        slides.push({
          layout: 'title',
          title: title,
          subtitle: options.subtitle || ''
        });
      }
      // Section/Slide title
      else if (line.startsWith('## ')) {
        if (currentSlide) slides.push(currentSlide);
        currentSlide = {
          layout: 'content',
          title: line.substring(3).trim(),
          bullets: []
        };
      }
      // Bullet points
      else if (line.startsWith('- ') || line.startsWith('* ')) {
        if (currentSlide) {
          currentSlide.bullets.push(line.substring(2).trim());
        }
      }
      // Image marker
      else if (line.startsWith('![image]')) {
        const imageDesc = line.substring(8).trim();
        if (currentSlide) {
          currentSlide.layout = 'image';
          currentSlide.imagePrompt = imageDesc;
          currentSlide.generateImage = options.generateImages !== false;
        }
      }
    }

    if (currentSlide) slides.push(currentSlide);

    // Ensure we have at least a title slide
    if (slides.length === 0) {
      slides.push({
        layout: 'title',
        title: title,
        subtitle: options.subtitle || ''
      });
    }

    return { title, slides };
  }

  /**
   * Get available templates
   * @param {string|Object} filters - Optional category filter or template query object
   * @returns {Promise<Array>} List of templates
   */
  async getTemplates(filters = null) {
    return this.templateEngine.getTemplates(filters || null).map((template) => ({
      ...template,
      packId: this.resolveTemplatePackId(template),
      packLabel: this.resolveTemplatePackLabel(template),
      useCase: template.useCases || template.useCase || [],
      packReason: this.resolvePackRationale(template),
    }));
  }

  /**
   * Get a single template by ID
   * @param {string} templateId - Template identifier
   * @returns {Promise<Object>} Template definition
   */
  async getTemplate(templateId) {
    return this.templateEngine.getTemplate(templateId);
  }

  getBlueprints() {
    return Object.values(BLUEPRINTS).map((blueprint) => ({
      ...blueprint,
      pipeline: this.getPipelineForBlueprint(blueprint.id),
      recommendedFormats: this.getRecommendedFormatsForBlueprint(blueprint.id),
    }));
  }

  getRecommendedFormatsForBlueprint(documentType = 'document') {
    const normalizedType = normalizeDocumentType(documentType);
    const intent = this.resolveIntentFromBlueprint(normalizedType);

    if (normalizedType === 'website-slides') {
      return ['pptx', 'html'];
    }

    if (intent === 'research') {
      return ['html', 'pdf', 'md'];
    }

    if (intent === 'dashboard') {
      return ['html', 'pdf'];
    }

    if (intent === 'html') {
      return ['html', 'md'];
    }

    if (intent === 'pdf') {
      return ['pdf', 'html'];
    }

    if (intent === 'training') {
      return ['pdf', 'html', 'xlsx', 'md'];
    }

    if (normalizedType === 'presentation' || normalizedType === 'pitch-deck') {
      return ['pptx', 'html'];
    }

    if (normalizedType === 'report' || normalizedType === 'data-story' || normalizedType === 'executive-brief') {
      return ['pdf', 'html', 'md'];
    }

    return ['html', 'pdf', 'md'];
  }

  normalizeCreationFormat(format = 'html') {
    const normalized = String(format || 'html').trim().toLowerCase();
    if (!normalized || normalized === 'docx' || normalized === 'doc' || normalized === 'word') {
      return 'html';
    }
    if (normalized === 'markdown') {
      return 'md';
    }
    return normalized;
  }

  resolveTemplatePackId(template = {}) {
    const packId = resolveTemplatePackHint(template);
    if (TEMPLATE_PACK_CATALOG[packId]) {
      return packId;
    }

    return packId;
  }

  resolveTemplatePackLabel(template = {}) {
    const packId = this.resolveTemplatePackId(template);
    return TEMPLATE_PACK_CATALOG[packId]?.label || buildPackLabel(packId);
  }

  resolvePackRationale(template = {}) {
    const packId = this.resolveTemplatePackId(template);
    return TEMPLATE_PACK_CATALOG[packId]?.rationale || '';
  }

  resolveIntentFromBlueprint(documentType = '') {
    const blueprint = resolveDocumentBlueprint(documentType);
    const blueprintIntent = normalizeIntentToken(blueprint.outputIntent);
    if (blueprintIntent) {
      return blueprintIntent;
    }

    return normalizeIntentToken(blueprintIdIntentHints(documentType));
  }

  inferBlueprintForIntent(intent = '', existingType = 'document') {
    const requestedIntent = normalizeIntentToken(intent);
    if (!requestedIntent) {
      return normalizeDocumentType(existingType);
    }

    if (requestedIntent === 'research') {
      return 'research-note';
    }

    if (requestedIntent === 'dashboard') {
      return 'html-dashboard-kpi';
    }

    if (requestedIntent === 'html') {
      return 'html-article';
    }

    if (requestedIntent === 'pdf') {
      return 'pdf-whitepaper';
    }

    if (requestedIntent === 'training') {
      return 'training-manual';
    }

    return normalizeDocumentType(requestedIntent);
  }

  buildTemplateMetadata(template = {}) {
    return {
      id: template.id,
      name: template.name,
      category: template.category,
      description: template.description,
      icon: template.icon,
      formats: this.getTemplateAvailableFormats(template),
      blueprint: template.blueprint || null,
      packId: this.resolveTemplatePackId(template),
      packLabel: this.resolveTemplatePackLabel(template),
      packRationale: this.resolvePackRationale(template),
      useCase: template.useCase || template.useCases || [],
      useCases: template.useCases || [],
      intent: template.intent || template.outputIntent || '',
      rationale: buildTemplateRationale({
        template,
        blueprint: resolveDocumentBlueprint(template.blueprint || 'document'),
      }),
    };
  }

  summarizePackSuggestions(templates = [], options = {}) {
    const limit = Math.max(1, Number(options.limit) || 6);
    const bucket = new Map();

    for (const template of templates) {
      const packId = this.resolveTemplatePackId(template);
      const current = bucket.get(packId) || {
        packId,
        label: this.resolveTemplatePackLabel(template),
        useCase: String(template.useCases?.[0] || template.useCase || this.resolveIntentFromBlueprint(template.blueprint || 'document')),
        intent: this.resolveIntentFromBlueprint(template.blueprint || 'document'),
        recommendedFormats: this.getTemplateAvailableFormats(template),
        templates: [],
        rationale: this.resolvePackRationale(template),
        score: 0,
      };

      current.templates.push(template);
      current.score = Math.max(current.score, Number(template.score || 0));
      bucket.set(packId, current);
    }

    const packEntries = Array.from(bucket.values())
      .map((entry) => ({
        packId: entry.packId,
        label: entry.label,
        useCase: entry.useCase,
        intent: entry.intent,
        rationale: entry.rationale,
        score: entry.score,
        templateCount: entry.templates.length,
        templates: entry.templates.slice(0, 3).map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          icon: template.icon,
        })),
        recommendedFormats: entry.templates.length === 0
          ? options.formats || []
          : Array.from(new Set(entry.templates.flatMap((template) => this.getTemplateAvailableFormats(template)))),
      }))
      .sort((a, b) => b.score - a.score || b.templateCount - a.templateCount || String(a.label || '').localeCompare(String(b.label || '')))
      .slice(0, limit);

    return packEntries.map(({ templates, score, ...entry }) => {
      const top = Array.isArray(templates) ? templates : [];
      return {
        ...entry,
        templateCount: top.length ? entry.templateCount : 0,
        templates: top,
      };
    });
  }

  getPipelineForBlueprint(documentType = '', format = '') {
    const normalizedType = normalizeDocumentType(documentType);
    const normalizedFormat = format ? this.normalizeCreationFormat(format) : '';

    if (normalizedFormat === 'pptx' || normalizedType === 'presentation' || normalizedType === 'pitch-deck' || normalizedType === 'website-slides') {
      return 'presentation';
    }

    return 'document';
  }

  inferDocumentTypeFromPrompt(prompt = '') {
    const normalized = String(prompt || '').trim().toLowerCase();
    if (!normalized) {
      return 'document';
    }

    const normalizedType = normalizeDocumentType(normalized);
    if (normalizedType !== 'document' && BLUEPRINTS[normalizedType]) {
      return normalizedType;
    }

    if (/\bwebsite\b[\s\S]{0,30}\b(slides|deck|storyboard|narrative)\b/.test(normalized)
      || /\b(slides|storyboard)\b[\s\S]{0,30}\bwebsite\b/.test(normalized)) {
      return 'website-slides';
    }

    if (/\b(research|investigate|literature|methodology|evidence|bibliography)\b/.test(normalized)) {
      return 'research-note';
    }

    if (/\b(training|manual|learner guide|facilitator guide|workbook|course|curriculum|lesson plan|job aid|standard operating procedure|sop)\b/.test(normalized)) {
      return 'training-manual';
    }

    if (/\b(dashboard|kpi|funnel|operational|conversion)\b/.test(normalized)) {
      return 'html-dashboard-kpi';
    }

    if (/\b(whitepaper|audit|publication|paper|reportable)\b/.test(normalized)) {
      return 'pdf-whitepaper';
    }

    if (/\b(article|product page|technical spec|html page|web page|landing)\b/.test(normalized)) {
      return 'html-article';
    }

    if (/\b(pitch deck|investor deck|fundraising deck)\b/.test(normalized)) {
      return 'pitch-deck';
    }

    if (/\b(executive brief|board brief|board update)\b/.test(normalized)) {
      return 'executive-brief';
    }

    if (/\b(data story|analytics report|insight report)\b/.test(normalized)) {
      return 'data-story';
    }

    if (/\breport\b/.test(normalized)) {
      return 'report';
    }

    if (/\bproposal\b/.test(normalized)) {
      return 'proposal';
    }

    if (/\bmemo\b/.test(normalized)) {
      return 'memo';
    }

    if (/\bletter\b/.test(normalized)) {
      return 'letter';
    }

    if (/\b(presentation|slides|deck)\b/.test(normalized)) {
      return 'presentation';
    }

    return 'document';
  }

  scoreTemplateForWorkflow(template = {}, blueprintId = 'document', prompt = '', intent = '', useCase = '', packId = '') {
    const normalizedPrompt = String(prompt || '').trim().toLowerCase();
    const tags = Array.isArray(template.tags) ? template.tags.map((tag) => String(tag || '').toLowerCase()) : [];
    const normalizedIntent = normalizeIntentToken(intent);
    const normalizedUseCase = normalizeIntentToken(useCase);
    const normalizedPackId = String(packId || '').trim().toLowerCase();
    const templatePackId = String(this.resolveTemplatePackId(template) || '').toLowerCase();
    const haystack = [
      template.id,
      template.name,
      template.description,
      template.category,
      ...tags,
      template.blueprint,
      ...(Array.isArray(template.useCases) ? template.useCases : []),
    ]
      .map((entry) => String(entry || '').toLowerCase())
      .join(' ');

    let score = 0;
    const blueprint = resolveDocumentBlueprint(blueprintId);

    if (template.blueprint === blueprintId) {
      score += 30;
    }

    if (haystack.includes(blueprintId)) {
      score += 18;
    }

    if (haystack.includes(blueprint.label.toLowerCase())) {
      score += 12;
    }

    if (blueprintId === 'pitch-deck' && /(pitch|investor|fundraising|startup)/.test(haystack)) {
      score += 16;
    }

    if (blueprintId === 'website-slides' && /(website|storyboard|creative|narrative)/.test(haystack)) {
      score += 16;
    }

    if (normalizedIntent) {
      if (blueprintId === 'report' && normalizedIntent === 'research') {
        score += 6;
      }

      if (String(template.intent || template.outputIntent || '').toLowerCase() === normalizedIntent) {
        score += 24;
      }

      if (String(template.outputIntent || '').toLowerCase() === normalizedIntent) {
        score += 24;
      }

      if (templatePackId === `research-${normalizedIntent}` || templatePackId === `${normalizedIntent}-suite` || templatePackId === `${normalizedIntent}-pack`) {
        score += 18;
      }

      if (templatePackId === normalizedPackId) {
        score += 20;
      }
    }

    if (normalizedPackId && templatePackId === normalizedPackId) {
      score += 24;
    }

    if (normalizedUseCase && Array.isArray(template.useCases) && template.useCases.some((entry) => (
      String(entry || '').toLowerCase().includes(normalizedUseCase)
    ))) {
      score += 14;
    }

    if ((blueprintId === 'report' || blueprintId === 'data-story') && /(report|data|analytics|insight|technical)/.test(haystack)) {
      score += 14;
    }

    if (blueprintId === 'executive-brief' && /(executive|brief|board|summary)/.test(haystack)) {
      score += 14;
    }

    if (blueprintId === 'training-manual' && /(training|manual|learner|facilitator|workbook|course|curriculum|lesson|module|job aid|assessment|checklist)/.test(haystack)) {
      score += 18;
    }

    if (normalizedPrompt) {
      const promptTerms = Array.from(new Set(
        normalizedPrompt
          .split(/[^a-z0-9]+/)
          .map((term) => term.trim())
          .filter((term) => term.length > 3),
      ));
      score += promptTerms.reduce((sum, term) => sum + (haystack.includes(term) ? 2 : 0), 0);
    }

    return score;
  }

  recommendDocumentWorkflow({
    prompt = '',
    documentType = '',
    intent = '',
    useCase = '',
    packId = '',
    format = '',
    limit = 4,
    includePackSummaries = true,
  } = {}) {
    const requestedIntent = normalizeIntentToken(intent);
    const requestedUseCase = normalizeIntentToken(useCase);
    const requestedPackId = String(packId || '').trim().toLowerCase();
    const inferredFromPrompt = this.inferDocumentTypeFromPrompt(prompt);
    const selectedType = documentType
      ? normalizeDocumentType(documentType)
      : (requestedIntent
        ? this.inferBlueprintForIntent(requestedIntent, inferredFromPrompt || 'document')
        : normalizeDocumentType(inferredFromPrompt));
    const inferredType = requestedIntent
      ? this.inferBlueprintForIntent(requestedIntent, selectedType)
      : selectedType;
    const blueprint = resolveDocumentBlueprint(inferredType);
    const recommendedFormats = this.getRecommendedFormatsForBlueprint(inferredType);
    const normalizedFormat = String(format || '').trim().toLowerCase();
    const recommendedFormat = recommendedFormats.includes(normalizedFormat)
      ? normalizedFormat
      : recommendedFormats[0];
    const pipeline = this.getPipelineForBlueprint(inferredType, recommendedFormat);
    const scoredTemplates = this.templateEngine.getTemplates({
      format: recommendedFormat,
      intent: requestedIntent,
      useCase: requestedUseCase,
      packId: requestedPackId,
    }).length > 0
      ? this.templateEngine.getTemplates({
        format: recommendedFormat,
        intent: requestedIntent,
        useCase: requestedUseCase,
        packId: requestedPackId,
      }).map((template) => ({
        ...template,
        score: this.scoreTemplateForWorkflow(template, inferredType, prompt, requestedIntent, requestedUseCase, requestedPackId),
      }))
      : this.templateEngine.getTemplates({
        format: recommendedFormat,
        intent: requestedIntent,
        useCase: requestedUseCase,
      }).map((template) => ({
        ...template,
        score: this.scoreTemplateForWorkflow(template, inferredType, prompt, requestedIntent, requestedUseCase, requestedPackId),
      }));

    const compatibleTemplates = scoredTemplates.filter((template) => (
      this.getTemplateAvailableFormats(template).includes(recommendedFormat)
    ));

    const templatePool = compatibleTemplates.length > 0
      ? compatibleTemplates
      : scoredTemplates;

    const enrichedTemplates = templatePool
      .map((template) => ({
        ...this.buildTemplateMetadata(template),
        score: template.score,
        scoreReason: template.score > 0 ? buildTemplateRationale({
          template,
          blueprint,
          format: recommendedFormat,
          intent: requestedIntent,
          useCase: requestedUseCase,
        }) : 'No clear fit yet',
      }))
      .filter((template) => template.score > 0 || templatePool.length < 3);

    const recommendedTemplates = enrichedTemplates
      .sort((a, b) => b.score - a.score || String(a.name || '').localeCompare(String(b.name || '')))
      .slice(0, Math.max(1, Number(limit) || 4))
      .map((template) => ({
        id: template.id,
        name: template.name,
        category: template.category,
        description: template.description,
        icon: template.icon,
        formats: this.getTemplateAvailableFormats(template),
        packId: template.packId,
        packLabel: template.packLabel,
        packRationale: template.packRationale,
        blueprint: template.blueprint || null,
        useCases: template.useCases || [],
        intent: template.intent || '',
        score: template.score,
        rationale: template.scoreReason,
      }));

    const scoredTemplatePool = enrichedTemplates.filter((template) => template.score > 0);
    const selectedPackId = requestedPackId || this.resolveTemplatePackId(recommendedTemplates[0] || {});
    const packSuggestions = includePackSummaries
      ? this.summarizePackSuggestions(scoredTemplatePool, {
        limit: 6,
        formats: [recommendedFormat],
      })
      : [];

    const designOptions = getDocumentLayoutOptions({
      blueprintId: blueprint.id,
      format: recommendedFormat,
      limit: 3,
    });
    const selectedDesignOption = designOptions[0] || null;

    return {
      requestedType: String(documentType || '').trim() || null,
      requestedIntent: requestedIntent || null,
      requestedUseCase: requestedUseCase || null,
      inferredType,
      packId: selectedPackId || null,
      availableFormats: this.getTemplateAvailableFormats({
        formats: [recommendedFormat],
      }),
      blueprint: {
        id: blueprint.id,
        label: blueprint.label,
        goal: blueprint.goal,
        narrative: blueprint.narrative,
      },
      pipeline,
      recommendedFormat,
      recommendedFormats,
      recommendedTemplates,
      recommendedTemplatePacks: packSuggestions,
      designOptions,
      selectedDesignOption,
      checklist: [...blueprint.requiredElements],
      structurePatterns: [...blueprint.structurePatterns],
      recommendationsFallbackReason: scoredTemplates.length === 0
        ? 'No template match for requested intent; defaults used.'
        : null,
      nextAction: pipeline === 'presentation'
        ? 'Start with a narrative slide outline, then generate the deck.'
        : 'Start with a strong title, summary, and section structure before generating the file.',
    };
  }

  derivePlanTitle(prompt = '', blueprint = {}) {
    const normalizedPrompt = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!normalizedPrompt) {
      return blueprint?.label ? blueprint.label.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Document Plan';
    }

    const candidate = normalizedPrompt
      .replace(/^(create|build|make|write|draft|prepare|generate)\s+/i, '')
      .replace(/[.?!].*$/, '')
      .trim();

    if (!candidate) {
      return blueprint?.label ? blueprint.label.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Document Plan';
    }

    return candidate.charAt(0).toUpperCase() + candidate.slice(1);
  }

  buildPlanItemsFromBlueprint(blueprint, pipeline = 'document') {
    const elements = Array.isArray(blueprint?.requiredElements) ? blueprint.requiredElements : [];

    if (pipeline === 'presentation') {
      return [
        {
          index: 1,
          layout: 'title',
          title: 'Title Slide',
          purpose: 'Open with the core promise or framing for the presentation.',
        },
        ...elements.map((element, index) => ({
          index: index + 2,
          layout: /proof|metric|traction|chart|data/i.test(element) ? 'chart' : (/product|feature|reveal|hero/i.test(element) ? 'image' : 'content'),
          title: element,
          purpose: `Cover ${String(element || '').toLowerCase()}.`,
        })),
      ];
    }

    return elements.map((element, index) => ({
      index: index + 1,
      heading: element,
      purpose: `Address ${String(element || '').toLowerCase()} clearly and concretely.`,
      suggestedBlocks: /metric|signal|trend|chart|data/i.test(element)
        ? ['summary', 'stats', 'chart']
        : (/risk|warning/i.test(element) ? ['summary', 'callout', 'bullets'] : ['summary', 'paragraphs']),
    }));
  }

  getProductionToolchain(format = '') {
    const normalizedFormat = this.normalizeCreationFormat(format || 'html');
    const common = {
      customGeneration: true,
      templateUse: 'Templates provide structure and constraints; final artifacts are generated through the active render pipeline.',
      supportingTools: ['document-design-engine', 'document-layout-catalog', 'document-quality-standard'],
      qualityPasses: ['strategy-architect', 'background-art-director', 'evidence-editor', 'accessibility-reviewer', 'final-polish-editor'],
    };

    const toolchains = {
      html: {
        ...common,
        renderPipeline: ['ai-document-generator', 'multi-agent-quality-pass', 'document-design-engine', 'html-renderer'],
        computeTools: ['graph-diagram', 'code-sandbox'],
        visualCapabilities: ['background surface system', 'curated layout shells', 'section images', 'inline charts', 'Mermaid-ready HTML', 'local Chart.js/D3/Three.js/Plotly/ECharts sandbox libraries', 'CodeMirror/highlight.js/Marked/PDF.js/Mammoth document and code viewers'],
        packageTargets: ['static-html', 'vite-preview-bundle'],
        browserLibraries: buildSandboxBrowserLibraryInstructions(),
      },
      pdf: {
        ...common,
        renderPipeline: ['ai-document-generator', 'multi-agent-quality-pass', 'html-renderer', 'headless-browser-pdf', 'pdfmake-fallback'],
        computeTools: ['graph-diagram', 'artifact-renderer'],
        visualCapabilities: ['background surface system', 'browser-rendered layout fidelity', 'embedded images', 'charts', 'tables'],
        packageTargets: ['pdf'],
      },
      pptx: {
        ...common,
        renderPipeline: ['ai-presentation-structure', 'multi-agent-quality-pass', 'pptxgenjs'],
        computeTools: ['image-generation', 'graph-diagram'],
        visualCapabilities: ['background surface system', 'custom slide layouts', 'image slides', 'metric cards', 'chart slides'],
        packageTargets: ['pptx', 'html-deck-preview'],
      },
      xlsx: {
        ...common,
        renderPipeline: ['structured-content-normalizer', 'xlsx-workbook-builder'],
        computeTools: ['artifact-renderer'],
        visualCapabilities: ['overview sheet', 'section sheets', 'chart data sheets', 'table sheets'],
        packageTargets: ['xlsx', 'html-workbook-preview'],
      },
      md: {
        ...common,
        renderPipeline: ['structured-content-normalizer', 'markdown-renderer'],
        computeTools: ['graph-diagram'],
        visualCapabilities: ['graph embeds', 'portable source notes'],
        packageTargets: ['markdown'],
      },
    };

    return toolchains[normalizedFormat] || {
      ...common,
      renderPipeline: ['structured-content-normalizer'],
      computeTools: [],
      visualCapabilities: [],
      packageTargets: [normalizedFormat],
    };
  }

  getDocumentProductionCapabilities() {
    return {
      formats: this.getSupportedFormats().map((format) => ({
        ...format,
        toolchain: this.getProductionToolchain(format.id),
      })),
      suiteActions: [
        {
          id: 'generate-suite',
          description: 'Build coordinated PDF, HTML, PPTX, XLSX, Markdown, graph, and sandbox preview outputs from one grounded prompt.',
          computeTools: ['document-workflow', 'graph-diagram', 'code-sandbox', 'artifact-renderer'],
        },
      ],
      policy: {
        templateUse: 'Use templates as curated starting structures, not final canned output.',
        visualDocuments: 'Prefer generated charts, diagrams, verified images, intentional background systems, browser-rendered PDFs, and Vite/static preview bundles when they materially improve the deliverable.',
        qualityStandard: 'AI document generation includes built-in strategy, background design, evidence, accessibility, and final polish passes unless explicitly disabled.',
        creationLoop: 'Use a Kimi K2.6-style creation loop: user-intent lock, context decisions, artifact architecture, build/render, critic repair, and handoff proof.',
        userAlignment: 'Carry user goal, assumptions, open questions, acceptance checks, and verification notes in metadata or handoff notes so the final document can be judged against what the user actually wanted.',
      },
    };
  }

  buildDocumentPlan({
    prompt = '',
    documentType = '',
    intent = '',
    useCase = '',
    packId = '',
    format = '',
    tone = 'professional',
    length = 'medium',
    theme = '',
    designOptionId = '',
    limit = 4,
    existingContent = '',
    session = null,
  } = {}) {
    const recommendation = this.recommendDocumentWorkflow({
      prompt,
      documentType,
      intent,
      useCase,
      packId,
      format,
      limit,
    });
    const blueprint = resolveDocumentBlueprint(recommendation.inferredType);
    const title = this.derivePlanTitle(prompt, blueprint);
    const outlineType = recommendation.pipeline === 'presentation' ? 'slides' : 'sections';
    const creativity = buildDocumentCreativityPacket({
      prompt,
      documentType: recommendation.inferredType,
      format: recommendation.recommendedFormat || format,
      existingContent,
      session,
    });
    const designOptions = getDocumentLayoutOptions({
      blueprintId: blueprint.id,
      directionId: creativity.direction.id,
      format: recommendation.recommendedFormat || format,
      selectedId: designOptionId,
      limit: 3,
    });
    const selectedDesignOption = designOptions[0] || null;
    const themeSuggestion = theme || selectedDesignOption?.defaultTheme || creativity.themeSuggestion;
    const qualityStandard = buildDocumentQualityPlan({
      documentType: recommendation.inferredType,
      format: recommendation.recommendedFormat || format,
      designPlan: {
        selectedDesignOption,
        creativeDirection: creativity.direction,
        themeSuggestion,
      },
    });

    return {
      ...recommendation,
      tone,
      length,
      titleSuggestion: title,
      outlineType,
      outline: this.buildPlanItemsFromBlueprint(blueprint, recommendation.pipeline),
      themeSuggestion,
      designOptions,
      selectedDesignOption,
      designOptionId: selectedDesignOption?.id || '',
      creativeDirection: {
        id: creativity.direction.id,
        label: creativity.direction.label,
        rationale: creativity.direction.rationale,
      },
      qualityStandard,
      humanizationNotes: creativity.humanizationNotes,
      sampleHandling: creativity.sampleSignals.guidance,
      contextSignals: {
        recentTasks: creativity.continuity.recentTasks.length,
        recentArtifacts: creativity.continuity.recentArtifacts.length,
        recentMessages: creativity.continuity.recentMessages.length,
      },
      productionToolchain: this.getProductionToolchain(recommendation.recommendedFormat || format),
      productionCapabilities: this.getDocumentProductionCapabilities(),
    };
  }

  /**
   * Get supported document formats
   * @returns {Array} List of formats with metadata
   */
  getSupportedFormats() {
    return [
      { id: 'html', name: 'HTML Document', mimeType: 'text/html', extension: '.html', generator: 'custom-html-renderer' },
      { id: 'pdf', name: 'PDF Document', mimeType: 'application/pdf', extension: '.pdf', generator: 'browser-html-pdf' },
      { id: 'pptx', name: 'PowerPoint', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx', generator: 'pptxgenjs' },
      { id: 'xlsx', name: 'Excel Workbook', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx', generator: 'xlsx-workbook-builder' },
      { id: 'md', name: 'Markdown', mimeType: 'text/markdown', extension: '.md', generator: 'markdown-renderer' }
    ];
  }

  /**
   * Generate a unique ID
   * @returns {string} Unique identifier
   */
  generateId() {
    return `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate a filename
   * @param {string} name - Base name
   * @param {string} format - File format
   * @returns {string} Generated filename
   */
  generateFilename(name, format) {
    return createUniqueFilename(name, format, 'document');
  }

  validateTemplateFormatCompatibility(template = {}, format = '') {
    const normalizedFormat = String(format || '').trim().toLowerCase();
    if (!normalizedFormat) {
      return { supported: false, error: 'Document format is required.' };
    }

    const availableFormats = this.getTemplateAvailableFormats(template);
    if (availableFormats.length === 0) {
      return { supported: true };
    }

    if (availableFormats.includes(normalizedFormat)) {
      return { supported: true };
    }

    return {
      supported: false,
      error: `Template "${template.name || template.id || 'document'}" does not support ${normalizedFormat.toUpperCase()}. Available formats: ${availableFormats.join(', ')}`,
    };
  }

  storeGeneratedDocument({ document = {}, filename, mimeType, metadata = {}, preview = null }) {
    const content = document.buffer || document.content || '';
    const normalizedMimeType = mimeType || document.mimeType || 'application/octet-stream';
    const contentSize = Buffer.isBuffer(document.buffer)
      ? document.buffer.length
      : Buffer.isBuffer(document.content)
        ? document.content.length
        : Buffer.byteLength(String(document.content || ''), 'utf8');
    const previewHtml = typeof document.previewHtml === 'string' && document.previewHtml.trim()
      ? document.previewHtml
      : (normalizedMimeType === 'text/html'
        ? (Buffer.isBuffer(document.content) ? document.content.toString('utf8') : String(document.content || ''))
        : '');
    const extractedText = typeof document.extractedText === 'string' && document.extractedText.trim()
      ? document.extractedText
      : (previewHtml ? stripHtml(previewHtml) : '');
    const normalizedPreview = document.preview
      || (previewHtml ? { type: 'html', content: previewHtml } : preview);

    return this.storeDocument({
      id: this.generateId(),
      content,
      filename,
      mimeType: normalizedMimeType,
      size: contentSize,
      metadata,
      preview: normalizedPreview,
      previewHtml,
      extractedText,
    });
  }

  storeDocument(document) {
    if (!document || !document.id) {
      return document;
    }

    const contentBuffer = Buffer.isBuffer(document.content)
      ? document.content
      : Buffer.from(String(document.content || ''), 'utf-8');

    const stored = {
      ...document,
      contentBuffer,
      storedAt: new Date().toISOString(),
      size: document.size || contentBuffer.length,
      downloadUrl: `/api/documents/${document.id}/download`,
    };

    this.documentStore.set(document.id, stored);
    this.pruneStoredDocuments();

    return stored;
  }

  getDocument(id) {
    return this.documentStore.get(id) || null;
  }

  pruneStoredDocuments() {
    if (this.documentStore.size <= this.maxStoredDocuments) {
      return;
    }

    const oldestIds = Array.from(this.documentStore.entries())
      .sort((a, b) => new Date(a[1].storedAt || 0).getTime() - new Date(b[1].storedAt || 0).getTime())
      .slice(0, this.documentStore.size - this.maxStoredDocuments)
      .map(([id]) => id);

    oldestIds.forEach((id) => this.documentStore.delete(id));
  }

  async renderDocument({ format, template = null, content = null, title = 'document', options = {}, rawText = '' }) {
    const normalizedFormat = this.normalizeCreationFormat(format || 'html');
    const structuredContent = content || this.templateToContent(template, options);
    const designPlan = buildDocumentDesignPlan({
      content: structuredContent,
      format: normalizedFormat,
      tone: options.tone || 'professional',
      length: options.length || 'medium',
      documentType: options.documentType || structuredContent.documentType || template?.blueprint || template?.id || 'document',
      requestedPlan: options.designPlan || null,
      theme: options.theme || structuredContent.theme || options.designPlan?.themeSuggestion || '',
    });

    if (template && this.shouldRenderTemplateAsPresentation(template, normalizedFormat)) {
      const presentationContent = this.templateToPresentationContent(template, options);
      if (normalizedFormat === 'html') {
        return this.renderPresentationDeck(presentationContent, options);
      }
      if (normalizedFormat === 'pptx') {
        const pptxGenerator = this.generators.pptx;
        if (!pptxGenerator) {
          throw new Error('PPTX generator not available');
        }

        return pptxGenerator.generateFromContent(presentationContent, options);
      }
    }

    if (normalizedFormat === 'html' || normalizedFormat === 'md' || normalizedFormat === 'markdown') {
      const rendered = this.renderTextDocument(structuredContent, normalizedFormat, designPlan);
      return {
        content: rendered.content,
        mimeType: rendered.mimeType,
        previewHtml: normalizedFormat === 'html' ? rendered.content : '',
        extractedText: stripHtml(rendered.content),
        metadata: {
          format: normalizedFormat === 'markdown' ? 'md' : normalizedFormat,
          title: structuredContent.title || title,
          sections: structuredContent.sections?.length || 0,
          design: {
            blueprint: designPlan.blueprint.id,
            theme: designPlan.theme.id,
            background: designPlan.background ? {
              id: designPlan.background.id,
              label: designPlan.background.label,
            } : null,
            outlineItems: designPlan.outline.length,
            layout: designPlan.layoutChoice?.id || null,
          },
        },
      };
    }

    const generator = this.generators[normalizedFormat];
    if (!generator) {
      throw new Error(`Unsupported format: ${format}`);
    }

    if ((content || template) && normalizedFormat === 'pdf') {
      const renderedHtml = this.renderTextDocument(structuredContent, 'html', designPlan);
      const previewHtml = renderedHtml.content;
      const extractedText = stripHtml(previewHtml);
      const browserBuffer = await renderPdfViaBrowser(previewHtml, structuredContent.title || title, {
        designPlan,
      });

      if (browserBuffer) {
        return {
          buffer: browserBuffer,
          mimeType: generator.mimeType,
          previewHtml,
          extractedText,
          metadata: {
            format: 'pdf',
            title: structuredContent.title || title,
            sections: structuredContent.sections?.length || 0,
            renderEngine: 'browser-html',
            sourceHtml: previewHtml,
            design: {
              blueprint: designPlan.blueprint.id,
              theme: designPlan.theme.id,
              background: designPlan.background ? {
                id: designPlan.background.id,
                label: designPlan.background.label,
              } : null,
              outlineItems: designPlan.outline.length,
              layout: designPlan.layoutChoice?.id || null,
            },
          },
        };
      }

      const fallbackPdf = await generator.generateFromContent(structuredContent, {
        ...options,
        designPlan,
        sourceHtml: previewHtml,
      });

      return {
        ...fallbackPdf,
        previewHtml,
        extractedText,
        metadata: {
          ...(fallbackPdf.metadata || {}),
          renderEngine: 'pdfmake',
          sourceHtml: previewHtml,
        },
      };
    }

    if ((content || template) && normalizedFormat === 'xlsx' && typeof generator.generateFromContent === 'function') {
      return generator.generateFromContent(structuredContent, {
        ...options,
        designPlan,
      });
    }

    if (content && typeof generator.generateFromContent === 'function') {
      return generator.generateFromContent(content, {
        ...options,
        designPlan,
      });
    }

    if (template && typeof generator.generate === 'function') {
      return generator.generate(template, options);
    }

    if (rawText && typeof generator.generateFromText === 'function') {
      return generator.generateFromText(rawText, options);
    }

    throw new Error(`Unsupported format: ${format}`);
  }

  renderTextDocument(content, format, designPlan = null) {
    const plan = designPlan || buildDocumentDesignPlan({ content, format });
    const title = plan.title || content?.title || 'Document';
    const subtitle = plan.subtitle ? `<p class="document-subtitle">${this.escapeHtml(plan.subtitle)}</p>` : '';
    const sections = Array.isArray(content?.sections) ? content.sections : [];
    const normalizedFormat = format === 'markdown' ? 'md' : format;
    const layoutChoice = plan.layoutChoice
      || findDocumentLayout(plan.selectedDesignOption?.id || '')
      || getDocumentLayoutOptions({
        blueprintId: plan.blueprint?.id || content?.documentType || 'document',
        directionId: plan.creativeDirection?.id || '',
        format: normalizedFormat,
        limit: 1,
      })[0]
      || findDocumentLayout('editorial-rhythm');

    if (normalizedFormat === 'html') {
      const showOutline = Boolean(layoutChoice?.showOutline !== false && plan.outline.length > 0);
      const layoutIdeas = Array.isArray(layoutChoice?.minorIdeas)
        ? layoutChoice.minorIdeas.slice(0, 2)
        : [];
      const outlineHtml = showOutline
        ? `<nav class="document-outline"><div class="document-outline-header"><span>${this.escapeHtml(layoutChoice?.navigationLabel || 'Plan')}</span><strong>${this.escapeHtml(layoutChoice?.navigationTitle || 'Structured flow')}</strong></div><ol>${plan.outline.map((item) => `
          <li><a href="#${this.escapeHtml(`section-${item.index}`)}"><span>${this.escapeHtml(item.number)}</span><strong>${this.escapeHtml(item.heading)}</strong><em>${this.escapeHtml(item.layout)}</em></a></li>
        `).join('')}</ol></nav>`
        : '';
      const body = [
        `<div class="document-shell document-theme-${this.escapeHtml(plan.theme.id)} document-layout-${this.escapeHtml(layoutChoice?.id || 'editorial-rhythm')}">`,
        `<header class="document-hero">`,
        `<div class="document-hero-copy">`,
        `<p class="document-eyebrow">${this.escapeHtml(plan.hero.eyebrow)}</p>`,
        `<h1>${this.escapeHtml(title)}</h1>`,
        subtitle,
        `<p class="document-hero-narrative">${this.escapeHtml(plan.hero.narrative)}</p>`,
        `</div>`,
        `<aside class="document-summary-panel">`,
        `<span class="summary-panel-label">Production Lens</span>`,
        `<strong>${this.escapeHtml(layoutChoice?.label || plan.hero.summary)}</strong>`,
        `<p>${this.escapeHtml(layoutChoice?.summary || plan.blueprint.goal)}</p>`,
        layoutIdeas.length > 0
          ? `<div class="summary-panel-ideas">${layoutIdeas.map((idea) => `<span>${this.escapeHtml(idea)}</span>`).join('')}</div>`
          : '',
        `</aside>`,
        `</header>`,
        plan.insightCards.length > 0 ? `<section class="document-insight-strip">${plan.insightCards.map((card) => `
          <article class="insight-card">
            <span>${this.escapeHtml(card.label)}</span>
            <strong>${this.escapeHtml(card.value)}</strong>
            <p>${this.escapeHtml(card.detail)}</p>
          </article>
        `).join('')}</section>` : '',
        `<div class="document-layout-frame">`,
        outlineHtml,
        `<main class="document-flow">`,
        ...sections.map((section, index) => this.renderSectionHtml(section, plan.sections[index], layoutChoice)),
        `</main>`,
        `</div>`,
        '</div>',
      ].join('\n');

      return {
        content: ensureHtmlDocument(
          `<html><head>${this.renderDocumentStyles(plan.theme, plan.background)}</head><body>${body}</body></html>`,
          title,
        ),
        mimeType: 'text/html',
      };
    }

    const markdown = [
      `# ${title}`,
      content?.subtitle ? `_${content.subtitle}_` : '',
      content?.subtitle ? '' : '',
      '',
      ...sections.flatMap((section) => this.renderSectionMarkdown(section)),
    ].join('\n');

    return {
      content: markdown,
      mimeType: 'text/markdown',
    };
  }

  renderSectionHtml(section = {}, sectionPlan = {}, layoutChoice = null) {
    const level = Math.min(Math.max(Number(section.level) || 1, 1), 6);
    const heading = section.heading ? `<h${level + 1}>${this.escapeHtml(section.heading)}</h${level + 1}>` : '';
    const chromeLabel = sectionPlan.layout || 'narrative';
    const blocks = [
      this.renderSectionImageHtml(section),
      this.renderRichTextBlocks(String(section.content || '')),
      this.renderBulletListHtml(section.bullets),
      this.renderCalloutHtml(section.callout),
      this.renderStatsHtml(section.stats),
      this.renderTableHtml(section.table),
      this.renderChartHtml(section.chart),
    ].filter(Boolean).join('\n');
    return `
      <section class="document-section layout-${this.escapeHtml(sectionPlan.layout || 'narrative')}" id="${this.escapeHtml(sectionPlan.anchor || '')}">
        <div class="section-chrome">
          <span class="section-number">${this.escapeHtml(sectionPlan.number || '')}</span>
          <span class="section-layout">${this.escapeHtml(chromeLabel)}</span>
        </div>
        <div class="section-content">
          ${heading}
          ${blocks}
        </div>
      </section>
    `.trim();
  }

  renderSectionImageHtml(section = {}) {
    const imageUrl = String(section.imageUrl || section.image_url || '').trim();
    if (!/^https?:\/\//i.test(imageUrl) && !/^\/api\/artifacts\/[^/]+\/download/i.test(imageUrl)) {
      return '';
    }

    const alt = section.imageAlt || section.image_alt || section.heading || 'Document image';
    const caption = section.imageCaption || section.image_caption || section.caption || '';
    return `
      <figure class="document-image">
        <img src="${this.escapeHtml(imageUrl)}" alt="${this.escapeHtml(alt)}" loading="lazy" />
        ${caption ? `<figcaption>${this.escapeHtml(caption)}</figcaption>` : ''}
      </figure>
    `.trim();
  }

  renderSectionMarkdown(section = {}) {
    const level = Math.min(Math.max(Number(section.level) || 1, 1), 6) + 1;
    const lines = [];

    if (section.heading) {
      lines.push(`${'#'.repeat(level)} ${section.heading}`);
      lines.push('');
    }

    if (section.content) {
      const contentLines = String(section.content || '').split('\n');
      contentLines.forEach((line) => {
        lines.push(line);
      });
    }
    if (Array.isArray(section.bullets) && section.bullets.length > 0) {
      section.bullets.forEach((bullet) => lines.push(`- ${bullet}`));
    }
    if (section.callout) {
      const callout = typeof section.callout === 'string'
        ? { body: section.callout }
        : section.callout;
      lines.push(`> ${callout.title ? `**${callout.title}** ` : ''}${callout.body || ''}`.trim());
    }
    if (Array.isArray(section.stats) && section.stats.length > 0) {
      lines.push('');
      section.stats.forEach((stat) => {
        lines.push(`- **${stat.label || 'Metric'}:** ${stat.value || ''}${stat.detail ? ` (${stat.detail})` : ''}`);
      });
    }
    if (section.table?.headers?.length || section.table?.rows?.length) {
      const headers = Array.isArray(section.table.headers) ? section.table.headers : [];
      if (headers.length > 0) {
        lines.push('');
        lines.push(`| ${headers.join(' | ')} |`);
        lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
      }
      (section.table.rows || []).forEach((row) => lines.push(`| ${row.join(' | ')} |`));
    }
    if (section.chart?.series?.length) {
      lines.push('');
      lines.push(`**${section.chart.title || 'Chart'}**`);
      section.chart.series.forEach((point) => lines.push(`- ${point.label}: ${point.value}`));
      if (section.chart.summary) {
        lines.push(section.chart.summary);
      }
    }
    lines.push('');
    return lines;
  }

  renderRichTextBlocks(text = '') {
    const blocks = String(text || '')
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);

    return blocks.map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${this.escapeHtml(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.length > 0 && lines.every((line) => /^\d+\.\s+/.test(line))) {
        return `<ol>${lines.map((line) => `<li>${this.escapeHtml(line.replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
      }
      return lines.map((line) => `<p>${this.escapeHtml(line)}</p>`).join('\n');
    }).join('\n');
  }

  normalizeAssemblySources(sources = []) {
    if (!Array.isArray(sources)) {
      return [];
    }

    return sources
      .map((source, index) => this.normalizeAssemblySource(source, index))
      .filter((source) => source.sections.length > 0);
  }

  normalizeAssemblySource(source = {}, index = 0) {
    if (typeof source === 'string') {
      const title = `Source ${index + 1}`;
      const sections = this.parseTextIntoSections(source, title);
      return {
        id: `source-${index + 1}`,
        type: 'text',
        title,
        sections,
        textLength: sections.reduce((total, section) => total + String(section.content || '').length, 0),
      };
    }

    const normalizedSource = source && typeof source === 'object' ? source : {};
    const contentObject = normalizedSource.content && typeof normalizedSource.content === 'object' && !Buffer.isBuffer(normalizedSource.content)
      ? normalizedSource.content
      : null;
    const title = String(
      normalizedSource.title
      || normalizedSource.name
      || normalizedSource.heading
      || contentObject?.title
      || normalizedSource.filename
      || `Source ${index + 1}`,
    ).trim();
    const type = String(
      normalizedSource.type
      || normalizedSource.sourceType
      || normalizedSource.format
      || normalizedSource.mimeType
      || 'source',
    ).trim().toLowerCase();
    const explicitSections = Array.isArray(normalizedSource.sections)
      ? normalizedSource.sections
      : (Array.isArray(contentObject?.sections) ? contentObject.sections : []);
    const sections = explicitSections.length > 0
      ? explicitSections.map((section, sectionIndex) => this.normalizeAssemblySection(section, title, sectionIndex)).filter(Boolean)
      : this.parseTextIntoSections(this.extractAssemblySourceText(normalizedSource), title);
    const textLength = sections.reduce((total, section) => total
      + String(section.content || '').length
      + (Array.isArray(section.bullets) ? section.bullets.join('').length : 0), 0);

    return {
      id: String(normalizedSource.id || normalizedSource.sourceId || `source-${index + 1}`),
      type,
      title,
      sections,
      textLength,
    };
  }

  normalizeAssemblySection(section = {}, fallbackHeading = 'Source', index = 0) {
    if (typeof section === 'string') {
      return {
        heading: fallbackHeading,
        content: normalizeWhitespace(section),
        level: 1,
      };
    }

    if (!section || typeof section !== 'object') {
      return null;
    }

    const content = normalizeWhitespace(
      section.content
      || section.text
      || section.body
      || section.markdown
      || '',
    );
    const bullets = Array.isArray(section.bullets)
      ? section.bullets.map((bullet) => String(bullet || '').trim()).filter(Boolean)
      : [];

    if (!content && bullets.length === 0 && !section.table && !section.chart && !section.stats?.length && !section.callout) {
      return null;
    }

    return {
      heading: String(section.heading || section.title || `${fallbackHeading} ${index + 1}`).trim(),
      content,
      level: Math.min(Math.max(Number(section.level) || 1, 1), 6),
      bullets,
      callout: section.callout || null,
      stats: Array.isArray(section.stats) ? section.stats : [],
      table: section.table || null,
      chart: section.chart || null,
    };
  }

  extractAssemblySourceText(source = {}) {
    const contentObject = source.content && typeof source.content === 'object' && !Buffer.isBuffer(source.content)
      ? source.content
      : null;
    const raw = [
      source.text,
      source.extractedText,
      source.markdown,
      source.body,
      typeof source.content === 'string' || Buffer.isBuffer(source.content) ? source.content : '',
      source.html,
      source.previewHtml,
      contentObject?.text,
      contentObject?.content,
      contentObject?.body,
      source.data ? JSON.stringify(source.data, null, 2) : '',
    ].find((value) => value != null && String(value).trim());

    if (!raw) {
      return '';
    }

    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    return this.looksLikeHtml(text) ? stripHtml(text) : normalizeWhitespace(text);
  }

  parseTextIntoSections(text = '', fallbackHeading = 'Source') {
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
      return [];
    }

    const lines = normalized.split('\n');
    const sections = [];
    let current = null;

    lines.forEach((line) => {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        if (current) {
          sections.push(current);
        }
        current = {
          heading: headingMatch[2].trim(),
          content: '',
          level: Math.min(6, headingMatch[1].length),
        };
        return;
      }

      if (!current) {
        current = {
          heading: fallbackHeading,
          content: '',
          level: 1,
        };
      }
      current.content = current.content ? `${current.content}\n${line}` : line;
    });

    if (current) {
      sections.push(current);
    }

    return sections.map((section, index) => this.normalizeAssemblySection(section, fallbackHeading, index)).filter(Boolean);
  }

  buildAssembledDocumentContent(sources = [], options = {}) {
    const title = String(options.title || options.name || '').trim()
      || (sources.length === 1 ? sources[0].title : 'Assembled Document');
    const sections = [];

    if (options.includeSourceOverview !== false && sources.length > 1) {
      sections.push({
        heading: 'Source Map',
        content: `This document combines ${sources.length} sources into a single structured artifact.`,
        level: 1,
        bullets: sources.map((source) => `${source.title} (${source.type || 'source'}): ${source.sections.length} section${source.sections.length === 1 ? '' : 's'}`),
      });
    }

    sources.forEach((source) => {
      if (source.sections.length > 1) {
        sections.push({
          heading: source.title,
          content: `Assembled from ${source.type || 'source'} input.`,
          level: 1,
        });
      }

      source.sections.forEach((section) => {
        const heading = source.sections.length === 1
          ? (section.heading && section.heading !== 'Source' ? section.heading : source.title)
          : section.heading;
        sections.push({
          ...section,
          heading,
          level: source.sections.length > 1 ? Math.min(6, (Number(section.level) || 1) + 1) : section.level,
        });
      });
    });

    return {
      title,
      subtitle: options.subtitle || `${sources.length} source${sources.length === 1 ? '' : 's'} assembled`,
      theme: options.theme || options.style || 'editorial',
      documentType: options.documentType || 'report',
      sections,
      metadata: {
        assembled: true,
        sourceCount: sources.length,
      },
    };
  }

  inferStoredDocumentFormat(document = {}) {
    const explicitFormat = this.normalizeCreationFormat(document.metadata?.format || document.format || '');
    if (explicitFormat) {
      return explicitFormat;
    }

    const filenameMatch = String(document.filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    if (filenameMatch) {
      return this.normalizeCreationFormat(filenameMatch[1]);
    }

    const mimeType = String(document.mimeType || '').toLowerCase();
    if (mimeType.includes('html')) return 'html';
    if (mimeType.includes('markdown')) return 'md';
    if (mimeType.includes('pdf')) return 'pdf';
    if (mimeType.includes('presentation')) return 'pptx';
    if (mimeType.includes('spreadsheet')) return 'xlsx';
    return '';
  }

  storedDocumentToContent(document = {}, options = {}) {
    const title = String(
      options.title
      || document.metadata?.title
      || String(document.filename || '').replace(/\.[^.]+$/, '')
      || 'Converted Document',
    ).trim();
    const previewHtml = typeof document.previewHtml === 'string' && document.previewHtml.trim()
      ? document.previewHtml
      : (document.preview?.type === 'html' ? document.preview.content : '');
    const text = normalizeWhitespace(
      document.extractedText
      || (previewHtml ? stripHtml(previewHtml) : '')
      || this.extractTextFromStoredDocumentBuffer(document),
    );

    if (!text) {
      throw new Error('Stored document does not include extractable text or an HTML preview for conversion.');
    }

    return {
      title,
      subtitle: options.subtitle || `Converted from ${document.filename || document.id || 'stored document'}`,
      theme: options.theme || 'editorial',
      documentType: options.documentType || 'document',
      sections: this.parseTextIntoSections(text, title),
    };
  }

  extractTextFromStoredDocumentBuffer(document = {}) {
    const format = this.inferStoredDocumentFormat(document);
    if (format && !['html', 'md', 'markdown', 'txt'].includes(format)) {
      return '';
    }

    const buffer = Buffer.isBuffer(document.contentBuffer)
      ? document.contentBuffer
      : (Buffer.isBuffer(document.content) ? document.content : null);
    const text = buffer
      ? buffer.toString('utf8')
      : (typeof document.content === 'string' ? document.content : '');

    if (!text || /\u0000/.test(text)) {
      return '';
    }

    return this.looksLikeHtml(text) ? stripHtml(text) : text;
  }

  looksLikeHtml(text = '') {
    return /<\/?[a-z][\s\S]*>/i.test(String(text || ''));
  }

  templateToContent(template = {}, options = {}) {
    const values = template?.values || template?.variables || {};
    const blueprintId = normalizeDocumentType(template?.blueprint || template?.id || options.documentType || 'document');

    if (blueprintId === 'letter') {
      return {
        title: values.subject || template?.name || 'Business Letter',
        subtitle: [values.date, values.recipient_name, values.company_name].filter(Boolean).join(' | '),
        theme: options.theme || 'executive',
        documentType: blueprintId,
        sections: [
          {
            heading: 'Purpose',
            content: String(values.body || ''),
            level: 1,
            callout: values.subject
              ? {
                title: 'Subject',
                body: String(values.subject),
                tone: 'highlight',
              }
              : null,
          },
          {
            heading: 'Correspondence Details',
            content: [
              values.sender_name ? `From: ${values.sender_name}${values.sender_title ? `, ${values.sender_title}` : ''}` : '',
              values.recipient_name ? `To: ${values.recipient_name}${values.recipient_title ? `, ${values.recipient_title}` : ''}` : '',
              values.company_name ? `Company: ${values.company_name}` : '',
              values.closing ? `Closing: ${values.closing}` : '',
            ].filter(Boolean).join('\n'),
            level: 1,
          },
        ].filter((section) => section.content || section.callout),
      };
    }

    if (blueprintId === 'executive-brief') {
      return {
        title: values.title || template?.name || 'Executive Brief',
        subtitle: [values.subtitle, values.audience].filter(Boolean).join(' | '),
        theme: options.theme || 'executive',
        documentType: blueprintId,
        sections: [
          {
            heading: 'Headline Summary',
            content: String(values.headline_summary || ''),
            level: 1,
            stats: this.parseMetricLines(values.key_metrics),
          },
          {
            heading: 'Current State',
            content: String(values.current_state || ''),
            level: 1,
          },
          {
            heading: 'Recommendation',
            content: String(values.recommendation || ''),
            level: 1,
            callout: values.risks
              ? {
                title: 'Key Risks',
                body: String(values.risks).split('\n').map((line) => line.trim()).filter(Boolean).join(' | '),
                tone: 'warning',
              }
              : null,
            bullets: this.parseLineList(values.next_steps),
          },
        ].filter((section) => section.content || section.stats?.length || section.bullets?.length || section.callout),
      };
    }

    if (blueprintId === 'data-story') {
      const series = this.parseSeriesLines(values.data_points);
      return {
        title: values.title || template?.name || 'Data Story Report',
        subtitle: values.timeframe || '',
        theme: options.theme || 'editorial',
        documentType: blueprintId,
        sections: [
          {
            heading: 'Topline Insight',
            content: String(values.headline_insight || ''),
            level: 1,
            chart: series.length > 0
              ? {
                title: 'Trend Snapshot',
                type: 'comparison',
                summary: values.timeframe ? `Observed across ${values.timeframe}.` : '',
                series,
              }
              : null,
          },
          {
            heading: 'Primary Drivers',
            content: String(values.drivers || ''),
            level: 1,
          },
          {
            heading: 'Comparisons',
            content: '',
            level: 1,
            bullets: this.parseLineList(values.comparisons),
          },
          {
            heading: 'Recommendations',
            content: '',
            level: 1,
            bullets: this.parseLineList(values.recommendations),
          },
        ].filter((section) => section.content || section.chart || section.bullets?.length),
      };
    }

    if (blueprintId === 'training-manual') {
      return {
        title: values.title || template?.name || 'Training and Manuals',
        subtitle: [values.audience, values.duration, values.delivery_mode].filter(Boolean).join(' | '),
        theme: options.theme || 'executive',
        documentType: blueprintId,
        sections: [
          {
            heading: 'Learner Profile',
            content: [
              values.audience ? `Audience: ${values.audience}` : '',
              values.prerequisites ? `Prerequisites: ${values.prerequisites}` : '',
              values.delivery_mode ? `Delivery mode: ${values.delivery_mode}` : '',
              values.duration ? `Duration: ${values.duration}` : '',
            ].filter(Boolean).join('\n'),
            level: 1,
            callout: values.design_notes
              ? {
                title: 'Design Direction',
                body: String(values.design_notes),
                tone: 'highlight',
              }
              : null,
          },
          {
            heading: 'Learning Objectives',
            content: '',
            level: 1,
            bullets: this.parseLineList(values.learning_objectives),
          },
          {
            heading: 'Module Path',
            content: String(values.module_plan || ''),
            level: 1,
          },
          {
            heading: 'Practice Activities',
            content: String(values.practice_activities || ''),
            level: 1,
          },
          {
            heading: 'Assessment and Validation',
            content: String(values.assessment || ''),
            level: 1,
            bullets: this.parseLineList(values.checklist),
          },
          {
            heading: 'Facilitator Notes and Job Aids',
            content: String(values.facilitator_notes || values.job_aids || ''),
            level: 1,
          },
        ].filter((section) => section.content || section.bullets?.length || section.callout),
      };
    }

    const sections = Object.entries(values)
      .filter(([, value]) => value != null && String(value).trim())
      .map(([key, value]) => ({
        heading: key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
        content: String(value),
        level: 1,
      }));

    return {
      title: values.title || template?.name || 'Document',
      subtitle: values.subtitle || '',
      theme: options.theme || 'editorial',
      documentType: blueprintId,
      sections,
    };
  }

  parseLineList(value = '') {
    return String(value || '')
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  }

  parseMetricLines(value = '') {
    return this.parseLineList(value).map((line) => {
      const [label, ...rest] = line.split(':');
      if (rest.length === 0) {
        return { label: line, value: '', detail: '' };
      }
      return {
        label: String(label || '').trim(),
        value: String(rest.shift() || '').trim(),
        detail: rest.join(':').trim(),
      };
    });
  }

  parseSeriesLines(value = '') {
    return this.parseLineList(value).map((line) => {
      const [label, ...rest] = line.split(':');
      if (rest.length === 0) {
        return null;
      }

      const rawValue = rest.join(':').trim();
      const numeric = Number(String(rawValue).replace(/[^0-9.-]/g, ''));
      return {
        label: String(label || '').trim(),
        value: Number.isFinite(numeric) ? numeric : rawValue,
      };
    }).filter(Boolean);
  }

  templateToPresentationContent(template = {}, options = {}) {
    const values = template?.values || template?.variables || {};
    return this.generators.pptx.buildContentFromTemplate(template, values, options);
  }

  getTemplateAvailableFormats(template = {}) {
    const formats = Array.isArray(template.formats) ? template.formats : [];
    const recommendedFormats = Array.isArray(template.recommendedFormats) ? template.recommendedFormats : [];
    return Array.from(new Set([...formats, ...recommendedFormats]
      .map((format) => this.normalizeCreationFormat(format))
      .filter(Boolean)));
  }

  escapeHtml(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Flatten nested data object for template variables
   * @param {Object} data - Nested data
   * @param {string} prefix - Key prefix
   * @returns {Object} Flattened data
   */
  flattenData(data, prefix = '') {
    const result = {};

    for (const [key, value] of Object.entries(data)) {
      const newKey = prefix ? `${prefix}_${key}` : key;

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(result, this.flattenData(value, newKey));
      } else {
        result[newKey] = value;
      }
    }

    return result;
  }

  /**
   * Convert expanded outline to document structure
   * @param {Array} outline - Expanded outline
   * @param {Object} options - Options
   * @returns {Object} Document structure
   */
  outlineToDocument(outline, options = {}) {
    const sections = [];

    const processNode = (node, level = 1) => {
      sections.push({
        heading: node.title || node.heading,
        content: node.content,
        level
      });

      if (node.subsections) {
        node.subsections.forEach(child => processNode(child, level + 1));
      }
    };

    outline.forEach(node => processNode(node));

    return {
      title: options.title || 'Generated Document',
      sections,
      metadata: {
        sections: sections.length,
        generatedAt: new Date().toISOString()
      }
    };
  }

  buildRenderableTemplate(template = {}, values = {}) {
    return {
      ...template,
      variableDefinitions: template.variables,
      values: { ...values },
      variables: { ...values },
    };
  }

  shouldUsePresentationPipeline(documentType = '', format = '') {
    return this.getPipelineForBlueprint(documentType, format) === 'presentation';
  }

  shouldRenderTemplateAsPresentation(template = {}, format = '') {
    const normalizedFormat = String(format || '').trim().toLowerCase();
    if (!['html', 'pptx'].includes(normalizedFormat)) {
      return false;
    }

    const blueprintId = normalizeDocumentType(template?.blueprint || template?.id || '');
    return this.getPipelineForBlueprint(blueprintId, normalizedFormat) === 'presentation';
  }

  inferSlideCount(length = '') {
    const normalized = String(length || '').trim().toLowerCase();
    if (normalized === 'short') return 5;
    if (normalized === 'long') return 10;
    if (normalized === 'detailed') return 12;
    return 7;
  }

  looksLikePresentationOutline(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return false;
    }

    return /^#\s+/m.test(normalized)
      || /^##\s+/m.test(normalized)
      || /^[-*]\s+/m.test(normalized)
      || /^slide\s+\d+/im.test(normalized);
  }

  renderPresentationDeck(presentation = {}, options = {}) {
    const theme = this.getPresentationTheme(presentation.theme || options.theme || 'editorial');
    const slides = Array.isArray(presentation.slides) ? presentation.slides : [];
    const title = presentation.title || 'Presentation';
    const subtitle = presentation.subtitle ? `<p class="deck-subtitle">${this.escapeHtml(presentation.subtitle)}</p>` : '';
    const styles = this.renderPresentationStyles(theme);
    const html = [
      `<div class="presentation-deck theme-${theme.id}">`,
      `<header class="deck-meta"><span>Website Slides</span><span>${slides.length} slides</span></header>`,
      `<main class="deck-track">`,
      slides.map((slide, index) => this.renderPresentationSlideHtml(slide, index, theme)).join('\n'),
      `</main>`,
      `<footer class="deck-footer"><strong>${this.escapeHtml(title)}</strong>${subtitle}</footer>`,
      `</div>`,
    ].join('\n');

    return {
      content: ensureHtmlDocument(
        `<html><head>${styles}</head><body>${html}</body></html>`,
        title,
      ),
      mimeType: 'text/html',
      metadata: {
        format: 'html',
        slideCount: slides.length,
        theme: theme.id,
        title,
      },
    };
  }

  renderPresentationSlideHtml(slide = {}, index = 0, theme = this.getPresentationTheme()) {
    const layout = String(slide.layout || (index === 0 ? 'title' : 'content')).toLowerCase();
    const stats = Array.isArray(slide.stats) ? slide.stats : [];
    const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
    const chartSeries = Array.isArray(slide.chart?.series) ? slide.chart.series : [];
    const columns = Array.isArray(slide.columns) ? slide.columns : [];
    const maxValue = Math.max(...chartSeries.map((point) => Number(point.value) || 0), 1);
    const imageCaption = slide.caption || slide.imageSource || '';
    const imageHtml = slide.imageUrl
      ? `
        <figure class="slide-figure">
          <img src="${this.escapeHtml(slide.imageUrl)}" alt="${this.escapeHtml(slide.imageAlt || slide.title || `Slide ${index + 1}`)}" loading="lazy" />
          ${imageCaption ? `<figcaption>${this.escapeHtml(imageCaption)}</figcaption>` : ''}
        </figure>
      `
      : '';

    const chartHtml = chartSeries.length > 0
      ? `<div class="slide-chart">${chartSeries.map((point) => `
          <div class="chart-row">
            <span class="chart-label">${this.escapeHtml(point.label || '')}</span>
            <div class="chart-bar"><span style="width:${Math.max(8, Math.round(((Number(point.value) || 0) / maxValue) * 100))}%"></span></div>
            <strong class="chart-value">${this.escapeHtml(String(point.value ?? ''))}</strong>
          </div>
        `).join('')}</div>`
      : '';

    return `
      <section class="deck-slide layout-${this.escapeHtml(layout)}">
        <div class="slide-index">${String(index + 1).padStart(2, '0')}</div>
        ${slide.kicker ? `<p class="slide-kicker">${this.escapeHtml(slide.kicker)}</p>` : ''}
        <h2>${this.escapeHtml(slide.title || `Slide ${index + 1}`)}</h2>
        ${slide.subtitle ? `<p class="slide-subtitle">${this.escapeHtml(slide.subtitle)}</p>` : ''}
        ${imageHtml}
        ${slide.content ? `<div class="slide-copy">${this.renderRichTextBlocks(slide.content)}</div>` : ''}
        ${bullets.length > 0 ? `<ul class="slide-bullets">${bullets.map((bullet) => `<li>${this.escapeHtml(bullet)}</li>`).join('')}</ul>` : ''}
        ${stats.length > 0 ? `<div class="slide-stats">${stats.map((stat) => `
          <article class="stat-card">
            <span>${this.escapeHtml(stat.label || 'Metric')}</span>
            <strong>${this.escapeHtml(String(stat.value ?? ''))}</strong>
            ${stat.detail ? `<p>${this.escapeHtml(stat.detail)}</p>` : ''}
          </article>
        `).join('')}</div>` : ''}
        ${columns.length > 0 ? `<div class="slide-columns">${columns.map((column) => `
          <article class="column-card">
            ${column.heading ? `<h3>${this.escapeHtml(column.heading)}</h3>` : ''}
            ${column.content ? `<div>${this.renderRichTextBlocks(column.content)}</div>` : ''}
            ${Array.isArray(column.bullets) && column.bullets.length ? `<ul>${column.bullets.map((bullet) => `<li>${this.escapeHtml(bullet)}</li>`).join('')}</ul>` : ''}
          </article>
        `).join('')}</div>` : ''}
        ${chartHtml}
        ${!slide.imageUrl && slide.imagePrompt ? `<p class="slide-visual-note">Visual direction: ${this.escapeHtml(slide.imagePrompt)}</p>` : ''}
      </section>
    `;
  }

  renderBulletListHtml(bullets = []) {
    if (!Array.isArray(bullets) || bullets.length === 0) {
      return '';
    }

    return `<ul>${bullets.map((bullet) => `<li>${this.escapeHtml(bullet)}</li>`).join('')}</ul>`;
  }

  renderCalloutHtml(callout) {
    if (!callout) {
      return '';
    }

    const normalized = typeof callout === 'string'
      ? { body: callout }
      : callout;

    return `
      <aside class="document-callout tone-${this.escapeHtml(normalized.tone || 'note')}">
        ${normalized.title ? `<strong>${this.escapeHtml(normalized.title)}</strong>` : ''}
        <p>${this.escapeHtml(normalized.body || '')}</p>
      </aside>
    `;
  }

  renderStatsHtml(stats = []) {
    if (!Array.isArray(stats) || stats.length === 0) {
      return '';
    }

    return `
      <div class="document-stats">
        ${stats.map((stat) => `
          <article class="document-stat">
            <span>${this.escapeHtml(stat.label || 'Metric')}</span>
            <strong>${this.escapeHtml(String(stat.value ?? ''))}</strong>
            ${stat.detail ? `<p>${this.escapeHtml(stat.detail)}</p>` : ''}
          </article>
        `).join('')}
      </div>
    `;
  }

  renderTableHtml(table = {}) {
    const normalizedTable = table && typeof table === 'object' ? table : {};
    const headers = Array.isArray(normalizedTable.headers) ? normalizedTable.headers : [];
    const rows = Array.isArray(normalizedTable.rows) ? normalizedTable.rows : [];
    if (headers.length === 0 && rows.length === 0) {
      return '';
    }

    const headerRow = headers.length > 0
      ? `<tr>${headers.map((header) => `<th>${this.escapeHtml(header)}</th>`).join('')}</tr>`
      : '';

    return `
      <div class="document-table-wrap">
        ${normalizedTable.caption ? `<p class="document-table-caption">${this.escapeHtml(normalizedTable.caption)}</p>` : ''}
        <table>
          <thead>${headerRow}</thead>
          <tbody>
            ${rows.map((row) => `<tr>${row.map((cell) => `<td>${this.escapeHtml(String(cell ?? ''))}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  renderChartHtml(chart = {}) {
    const normalizedChart = chart && typeof chart === 'object' ? chart : {};
    const series = Array.isArray(normalizedChart.series) ? normalizedChart.series : [];
    if (series.length === 0) {
      return '';
    }

    const maxValue = Math.max(...series.map((point) => Number(point.value) || 0), 1);
    return `
      <div class="document-chart">
        ${normalizedChart.title ? `<h4>${this.escapeHtml(normalizedChart.title)}</h4>` : ''}
        ${normalizedChart.summary ? `<p>${this.escapeHtml(normalizedChart.summary)}</p>` : ''}
        <div class="chart-stack">
          ${series.map((point) => `
            <div class="chart-row">
              <span class="chart-label">${this.escapeHtml(point.label || '')}</span>
              <div class="chart-bar"><span style="width:${Math.max(8, Math.round(((Number(point.value) || 0) / maxValue) * 100))}%"></span></div>
              <strong class="chart-value">${this.escapeHtml(String(point.value ?? ''))}</strong>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  getPresentationTheme(theme = 'editorial') {
    return resolveDocumentTheme(theme);
  }

  renderDocumentStyles(theme, background = null) {
    const resolvedBackground = background || buildDocumentBackgroundSpec({ theme });

    return `
      <style>
        @page {
          size: 11.33in 14.67in portrait;
          margin: 0.72in 0.65in 0.68in;
        }
        :root {
          --doc-bg: ${theme.background};
          --doc-bg-end: ${resolvedBackground.canvasEnd || theme.background};
          --doc-bg-wash: ${resolvedBackground.wash || theme.accentSoft};
          --doc-bg-wash-soft: ${resolvedBackground.washSoft || theme.panelAlt};
          --doc-bg-grid: ${resolvedBackground.gridLine || 'rgba(15, 23, 42, 0.04)'};
          --doc-bg-texture: ${resolvedBackground.textureLine || 'rgba(15, 23, 42, 0.03)'};
          --doc-shadow: ${resolvedBackground.shadow || 'rgba(15, 23, 42, 0.12)'};
          --doc-page: ${theme.page};
          --doc-panel: ${theme.panel};
          --doc-panel-alt: ${theme.panelAlt};
          --doc-chip-bg: ${theme.panelAlt};
          --doc-text: ${theme.text};
          --doc-muted: ${theme.muted};
          --doc-accent: ${theme.accent};
          --doc-accent-soft: ${theme.accentSoft};
          --doc-border: ${theme.border};
          --doc-chart-start: ${theme.chartStart};
          --doc-chart-end: ${theme.chartEnd};
          --doc-print-bg: ${resolvedBackground.print?.background || '#ffffff'};
          --doc-print-text: ${resolvedBackground.print?.text || '#111827'};
          --doc-print-muted: ${resolvedBackground.print?.muted || '#374151'};
          --doc-print-border: ${resolvedBackground.print?.border || '#d1d5db'};
        }
        body {
          background:
            linear-gradient(135deg, var(--doc-bg-wash) 0, transparent 28rem),
            linear-gradient(180deg, var(--doc-bg-wash-soft) 0, transparent 18rem),
            repeating-linear-gradient(90deg, var(--doc-bg-grid) 0 1px, transparent 1px 104px),
            repeating-linear-gradient(0deg, var(--doc-bg-texture) 0 1px, transparent 1px 104px),
            linear-gradient(180deg, var(--doc-bg), var(--doc-bg-end));
          color: var(--doc-text);
          font-family: "Aptos", "Segoe UI", sans-serif;
          margin: 0;
        }
        .document-shell { max-width: 1040px; margin: 0 auto; padding: 36px 24px 72px; }
        .document-hero { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 20px; background: var(--doc-page); border: 1px solid var(--doc-border); border-radius: 28px; padding: 30px; box-shadow: 0 24px 70px var(--doc-shadow); }
        .document-eyebrow, .section-layout, .summary-panel-label, .insight-card span { color: var(--doc-accent); text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.78rem; font-weight: 700; }
        .document-hero h1 { font-size: clamp(2.4rem, 5vw, 4.6rem); line-height: 0.94; margin: 0; max-width: 11ch; }
        .document-subtitle, .document-hero-narrative, .summary-panel-label + strong + p, .insight-card p, .document-outline em, .document-stat p { color: var(--doc-muted); }
        .document-subtitle { font-size: 1.05rem; margin: 12px 0 0; }
        .document-hero-narrative { font-size: 1rem; line-height: 1.7; max-width: 54ch; margin: 16px 0 0; }
        .document-summary-panel { border-radius: 22px; background: linear-gradient(180deg, var(--doc-panel-alt), var(--doc-panel)); padding: 18px; border: 1px solid var(--doc-border); display: flex; flex-direction: column; gap: 10px; }
        .document-summary-panel strong { font-size: 1.1rem; }
        .summary-panel-ideas { display: flex; flex-wrap: wrap; gap: 8px; }
        .summary-panel-ideas span { font-size: 0.82rem; color: var(--doc-text); background: var(--doc-chip-bg); border: 1px solid var(--doc-border); border-radius: 999px; padding: 6px 9px; }
        .document-insight-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin: 18px 0; }
        .insight-card { border-radius: 20px; background: var(--doc-page); border: 1px solid var(--doc-border); padding: 18px; box-shadow: 0 12px 38px var(--doc-shadow); }
        .insight-card strong { display: block; font-size: 1.3rem; margin-top: 8px; }
        .document-layout-frame { display: grid; gap: 18px; }
        .document-outline { background: var(--doc-page); border: 1px solid var(--doc-border); border-radius: 22px; padding: 22px; margin: 14px 0 20px; }
        .document-outline-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
        .document-outline-header span { color: var(--doc-accent); text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.78rem; font-weight: 700; }
        .document-outline ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
        .document-outline a { display: grid; grid-template-columns: 42px 1fr auto; gap: 14px; align-items: baseline; text-decoration: none; color: inherit; padding: 10px 12px; border-radius: 14px; }
        .document-outline a:hover { background: var(--doc-panel); }
        .document-flow { display: grid; gap: 18px; }
        .document-section { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 18px; background: var(--doc-page); border: 1px solid var(--doc-border); border-radius: 24px; padding: 24px; }
        .section-chrome { display: flex; flex-direction: column; gap: 8px; }
        .section-number { font-size: 2rem; line-height: 1; font-weight: 800; color: var(--doc-accent); }
        .section-content h2, .section-content h3, .section-content h4, .section-content h5, .section-content h6 { color: var(--doc-text); margin-top: 0; }
        .document-image { margin: 0 0 20px; }
        .document-image img { width: 100%; max-height: 360px; object-fit: cover; display: block; border-radius: 18px; border: 1px solid var(--doc-border); box-shadow: 0 18px 42px rgba(15, 23, 42, 0.12); }
        .document-image figcaption { color: var(--doc-muted); font-size: 0.9rem; margin-top: 8px; }
        p { line-height: 1.75; }
        ul, ol { padding-left: 1.25rem; }
        .document-callout { border-left: 4px solid var(--doc-accent); background: var(--doc-panel); padding: 16px 18px; margin: 18px 0; border-radius: 0 16px 16px 0; }
        .document-callout p { margin: 6px 0 0; }
        .document-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin: 22px 0; }
        .document-stat { border: 1px solid var(--doc-border); border-radius: 16px; padding: 16px; background: var(--doc-panel); }
        .document-stat span { display: block; color: var(--doc-muted); font-size: 0.86rem; text-transform: uppercase; letter-spacing: 0.08em; }
        .document-stat strong { display: block; font-size: 1.5rem; margin-top: 8px; }
        .document-table-wrap { margin: 20px 0; }
        .document-table-caption { font-size: 0.92rem; color: var(--doc-muted); margin-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 14px; background: var(--doc-panel); }
        th, td { padding: 12px 14px; border-bottom: 1px solid var(--doc-border); text-align: left; overflow-wrap: anywhere; }
        th { background: var(--doc-panel-alt); color: var(--doc-text); }
        pre, code { overflow-wrap: anywhere; }
        .document-chart { margin: 24px 0; }
        .chart-stack { display: grid; gap: 10px; }
        .chart-row { display: grid; grid-template-columns: 140px 1fr 64px; gap: 12px; align-items: center; }
        .chart-label, .chart-value { font-size: 0.92rem; }
        .chart-bar { background: var(--doc-border); border-radius: 999px; height: 12px; overflow: hidden; }
        .chart-bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--doc-chart-start), var(--doc-chart-end)); border-radius: 999px; }
        .document-layout-briefing-grid .document-outline,
        .document-layout-chapter-bands .document-outline,
        .document-layout-casefile-panels .document-outline { display: none; }
        .document-layout-briefing-grid .document-flow { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: stretch; }
        .document-layout-briefing-grid .document-section { grid-template-columns: 1fr; min-height: 100%; }
        .document-layout-briefing-grid .document-section.layout-lead,
        .document-layout-briefing-grid .document-section.layout-evidence,
        .document-layout-briefing-grid .document-section.layout-chart { grid-column: 1 / -1; }
        .document-layout-briefing-grid .section-chrome { flex-direction: row; align-items: center; justify-content: space-between; }
        .document-layout-briefing-grid .section-number { display: none; }
        .document-layout-briefing-grid .section-layout { padding: 6px 10px; border-radius: 999px; background: var(--doc-accent-soft); }
        .document-layout-chapter-bands .document-hero { grid-template-columns: 1fr; }
        .document-layout-chapter-bands .document-section { grid-template-columns: 1fr; padding: 0; background: transparent; border: 0; box-shadow: none; overflow: hidden; }
        .document-layout-chapter-bands .section-chrome { flex-direction: row; align-items: center; justify-content: space-between; padding: 18px 22px; background: linear-gradient(135deg, var(--doc-accent-soft), var(--doc-page)); border: 1px solid var(--doc-border); border-radius: 24px 24px 0 0; }
        .document-layout-chapter-bands .section-number { display: none; }
        .document-layout-chapter-bands .section-content { padding: 22px; background: var(--doc-page); border: 1px solid var(--doc-border); border-top: 0; border-radius: 0 0 24px 24px; }
        .document-layout-field-guide-rail .document-hero { grid-template-columns: 1fr; }
        .document-layout-field-guide-rail .document-layout-frame { grid-template-columns: 280px minmax(0, 1fr); align-items: start; }
        .document-layout-field-guide-rail .document-outline { position: sticky; top: 24px; margin: 0; }
        .document-layout-field-guide-rail .document-section { grid-template-columns: 1fr; }
        .document-layout-field-guide-rail .section-chrome { flex-direction: row; align-items: center; gap: 10px; }
        .document-layout-field-guide-rail .section-number { display: none; }
        .document-layout-field-guide-rail .section-layout { padding: 6px 10px; border-radius: 999px; background: var(--doc-panel-alt); border: 1px solid var(--doc-border); }
        .document-layout-casefile-panels .document-flow { gap: 22px; }
        .document-layout-casefile-panels .document-section { grid-template-columns: minmax(0, 1fr) 170px; }
        .document-layout-casefile-panels .section-chrome { order: 2; align-items: flex-end; justify-content: flex-start; }
        .document-layout-casefile-panels .section-number { font-size: 0.8rem; letter-spacing: 0.12em; text-transform: uppercase; padding: 6px 8px; border-radius: 999px; background: var(--doc-accent-soft); }
        .document-layout-casefile-panels .section-layout { text-align: right; }
        @media (max-width: 860px) {
          .document-hero, .document-section, .document-layout-field-guide-rail .document-layout-frame, .document-layout-casefile-panels .document-section { grid-template-columns: 1fr; }
          .document-outline a, .chart-row { grid-template-columns: 1fr; }
          .document-layout-field-guide-rail .document-outline { position: static; }
        }
        @media print {
          html, body { width: 11.33in; min-height: 14.67in; max-width: 100% !important; overflow: visible !important; }
          body { background: var(--doc-print-bg) !important; color: var(--doc-print-text) !important; }
          .document-shell { max-width: none; width: 100%; padding: 0; }
          .document-hero,
          .document-layout-frame,
          .document-outline,
          .document-flow,
          .document-section,
          .section-content {
            max-width: 100% !important;
          }
          .document-hero,
          .document-summary-panel,
          .insight-card,
          .document-outline,
          .document-section,
          .section-chrome,
          .section-content,
          .document-stat,
          .document-callout,
          table {
            background: var(--doc-print-bg) !important;
            color: var(--doc-print-text) !important;
            border-color: var(--doc-print-border) !important;
            box-shadow: none !important;
          }
          .document-hero,
          .document-section,
          .document-outline,
          .document-callout,
          .document-table-wrap,
          .document-image,
          .insight-card {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .document-flow { gap: 0 !important; }
          .document-section {
            border: 0 !important;
            border-top: 1px solid var(--doc-print-border) !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            background: transparent !important;
            padding: 0.22in 0 0 !important;
            margin: 0.18in 0 0 !important;
          }
          .document-flow > .document-section:first-child {
            border-top: 0 !important;
            padding-top: 0 !important;
            margin-top: 0 !important;
          }
          .document-layout-chapter-bands .section-chrome,
          .document-layout-chapter-bands .section-content {
            border-left: 0 !important;
            border-right: 0 !important;
            border-radius: 0 !important;
          }
          table { table-layout: fixed; width: 100% !important; max-width: 100% !important; }
          img, svg, canvas { max-width: 100% !important; height: auto !important; }
          pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
          .document-subtitle,
          .document-hero-narrative,
          .summary-panel-label + strong + p,
          .insight-card p,
          .document-outline em,
          .document-stat p,
          .document-image figcaption {
            color: var(--doc-print-muted) !important;
          }
        }
      </style>
    `;
  }

  renderPresentationStyles(theme) {
    const background = buildDocumentBackgroundSpec({
      theme,
      layoutChoice: { id: 'presentation-deck', label: 'Presentation Deck' },
      format: 'html',
    });

    return `
      <style>
        @page {
          size: 13.333in 7.5in landscape;
          margin: 0;
        }
        :root {
          --deck-bg: ${theme.background};
          --deck-bg-end: ${background.canvasEnd || theme.background};
          --deck-bg-wash: ${background.wash || theme.accentSoft};
          --deck-bg-wash-soft: ${background.washSoft || theme.panelAlt};
          --deck-bg-grid: ${background.gridLine || 'rgba(15, 23, 42, 0.04)'};
          --deck-shadow: ${background.shadow || 'rgba(15, 23, 42, 0.14)'};
          --deck-panel: ${theme.panel};
          --deck-card: ${theme.panelAlt};
          --deck-border: ${theme.border || 'rgba(15,23,42,0.12)'};
          --deck-text: ${theme.text};
          --deck-muted: ${theme.muted};
          --deck-accent: ${theme.accent};
          --deck-accent-soft: ${theme.accentSoft};
        }
        body {
          margin: 0;
          background:
            linear-gradient(135deg, var(--deck-bg-wash) 0, transparent 30rem),
            linear-gradient(180deg, var(--deck-bg-wash-soft) 0, transparent 20rem),
            repeating-linear-gradient(90deg, var(--deck-bg-grid) 0 1px, transparent 1px 112px),
            linear-gradient(180deg, var(--deck-bg), var(--deck-bg-end));
          color: var(--deck-text);
          font-family: "Space Grotesk", "Segoe UI", sans-serif;
        }
        .presentation-deck { padding: 28px; }
        .deck-meta, .deck-footer { max-width: 1180px; margin: 0 auto 18px; display: flex; justify-content: space-between; color: var(--deck-muted); font-size: 0.92rem; letter-spacing: 0.08em; text-transform: uppercase; }
        .deck-track { max-width: 1180px; margin: 0 auto; display: grid; gap: 28px; }
        .deck-slide { min-height: 88vh; background: var(--deck-panel); border: 1px solid var(--deck-border); border-radius: 32px; padding: 48px; position: relative; overflow: hidden; box-shadow: 0 30px 80px var(--deck-shadow); }
        .deck-slide::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 8px; background: linear-gradient(90deg, var(--deck-accent), transparent 76%); opacity: 0.9; }
        .deck-slide h2 { font-size: clamp(2.4rem, 5vw, 4.4rem); line-height: 0.95; margin: 0 0 12px; max-width: 10ch; position: relative; }
        .slide-index { position: absolute; top: 32px; right: 36px; color: var(--deck-muted); font-size: 0.9rem; letter-spacing: 0.08em; }
        .slide-kicker { color: var(--deck-accent); text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.8rem; margin: 0 0 16px; position: relative; }
        .slide-subtitle, .slide-visual-note, .deck-footer p { color: var(--deck-muted); max-width: 52ch; }
        .slide-copy p { max-width: 58ch; font-size: 1.08rem; line-height: 1.7; }
        .slide-figure { margin: 24px 0 28px; max-width: 760px; position: relative; z-index: 1; }
        .slide-figure img { width: 100%; max-height: 46vh; object-fit: cover; border-radius: 24px; display: block; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.18); }
        .slide-figure figcaption { margin-top: 10px; color: var(--deck-muted); font-size: 0.9rem; }
        .slide-bullets { max-width: 58ch; display: grid; gap: 10px; padding-left: 1.25rem; }
        .slide-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-top: 24px; }
        .stat-card, .column-card { padding: 18px; border-radius: 18px; background: var(--deck-card); border: 1px solid var(--deck-border); }
        .stat-card span { display: block; color: var(--deck-muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.08em; }
        .stat-card strong { display: block; font-size: 1.8rem; margin-top: 6px; }
        .slide-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; }
        .slide-chart { margin-top: 28px; display: grid; gap: 12px; max-width: 760px; }
        .chart-row { display: grid; grid-template-columns: 150px 1fr 70px; gap: 12px; align-items: center; }
        .chart-bar { height: 16px; background: rgba(15,23,42,0.09); border-radius: 999px; overflow: hidden; }
        .chart-bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--deck-accent), #fb7185); border-radius: 999px; }
        .layout-title { display: flex; flex-direction: column; justify-content: center; }
        .layout-section { background: linear-gradient(135deg, var(--deck-accent), #111827); color: #fff; }
        .layout-section .slide-kicker, .layout-section .slide-subtitle, .layout-section .slide-visual-note, .layout-section .slide-index { color: rgba(255,255,255,0.78); }
        .layout-section::before { background: linear-gradient(90deg, rgba(255,255,255,0.44), transparent 76%); }
        @media (max-width: 768px) {
          .presentation-deck { padding: 12px; }
          .deck-slide { min-height: auto; padding: 28px 22px; border-radius: 24px; }
          .slide-columns, .slide-stats { grid-template-columns: 1fr; }
          .chart-row { grid-template-columns: 1fr; }
        }
        @media print {
          body { background: #ffffff !important; color: #111827 !important; }
          .presentation-deck { padding: 0; }
          .deck-track { gap: 0; max-width: none; }
          .deck-meta, .deck-footer { display: none; }
          .deck-slide { break-after: page; page-break-after: always; min-height: 7.5in; border-radius: 0; }
          .deck-slide:last-child { break-after: auto; page-break-after: auto; }
          .deck-slide,
          .stat-card,
          .column-card {
            background: #ffffff !important;
            color: #111827 !important;
            border-color: #d1d5db !important;
            box-shadow: none !important;
          }
          .slide-subtitle,
          .slide-visual-note,
          .deck-footer p,
          .stat-card span {
            color: #374151 !important;
          }
        }
      </style>
    `;
  }
}

module.exports = { DocumentService };

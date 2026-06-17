const express = require('express');
const request = require('supertest');

jest.mock('../middleware/validate', () => ({
  validate: () => (_req, _res, next) => next(),
}));

jest.mock('../session-store', () => ({
  sessionStore: {
    get: jest.fn(),
    getOwned: jest.fn(),
  },
}));

const documentsRouter = require('./documents');
const { sessionStore } = require('../session-store');

describe('/api/documents route', () => {
  function buildApp(documentService, { artifactService = null, templateStore = null } = {}) {
    const app = express();
    app.use(express.json());
    app.locals.documentService = documentService;
    app.locals.artifactService = artifactService;
    app.locals.templateStore = templateStore;
    app.use('/api/documents', documentsRouter);
    return app;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('downloads a stored generated document', async () => {
    const documentService = {
      getDocument: jest.fn().mockReturnValue({
        id: 'doc-1',
        filename: 'launch-deck.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        metadata: { slideCount: 4 },
        contentBuffer: Buffer.from('pptx'),
      }),
    };

    const response = await request(buildApp(documentService)).get('/api/documents/doc-1/download');

    expect(response.status).toBe(200);
    expect(response.header['content-type']).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(documentService.getDocument).toHaveBeenCalledWith('doc-1');
  });

  test('serves generated documents inline when requested for preview', async () => {
    const documentService = {
      getDocument: jest.fn().mockReturnValue({
        id: 'doc-html-1',
        filename: 'climate-change.html',
        mimeType: 'text/html',
        metadata: { format: 'html' },
        contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Climate Change</h1></body></html>'),
      }),
    };

    const response = await request(buildApp(documentService)).get('/api/documents/doc-html-1/download?inline=1');

    expect(response.status).toBe(200);
    expect(response.header['content-type']).toContain('text/html');
    expect(response.header['content-disposition']).toBe('inline; filename="climate-change.html"');
    expect(response.header['origin-agent-cluster']).toBe('?0');
    expect(response.text).toContain('<h1>Climate Change</h1>');
  });

  test('serves inline documents with non-ascii metadata without invalid response headers', async () => {
    const documentService = {
      getDocument: jest.fn().mockResolvedValue({
        id: 'doc-html-unicode',
        filename: 'questionnaire-result.html',
        mimeType: 'text/html',
        metadata: { title: 'Questionnaire response ✓', prompt: 'Résumé avec unicode' },
        content: '<!DOCTYPE html><html><body><h1>Questionnaire</h1></body></html>',
      }),
    };

    const response = await request(buildApp(documentService)).get('/api/documents/doc-html-unicode/download?inline=1');

    expect(response.status).toBe(200);
    expect(response.header['x-document-metadata']).toBe('{}');
    expect(response.header['x-document-metadata-base64']).toBeTruthy();
    expect(response.text).toContain('<h1>Questionnaire</h1>');
  });

  test('omits oversized document metadata from download headers', async () => {
    const documentService = {
      getDocument: jest.fn().mockReturnValue({
        id: 'doc-html-large-metadata',
        filename: 'large-metadata.html',
        mimeType: 'text/html',
        metadata: { prompt: 'x'.repeat(12000) },
        contentBuffer: Buffer.from('<!DOCTYPE html><html><body><h1>Large</h1></body></html>'),
      }),
    };

    const response = await request(buildApp(documentService)).get('/api/documents/doc-html-large-metadata/download?inline=1');

    expect(response.status).toBe(200);
    expect(response.header['x-document-metadata']).toBe('{}');
    expect(response.header['x-document-metadata-base64']).toBeUndefined();
    expect(response.header['x-document-metadata-truncated']).toBe('true');
  });

  test('returns a clean gone response when stored document content is missing', async () => {
    const documentService = {
      getDocument: jest.fn().mockReturnValue({
        id: 'doc-empty',
        filename: 'empty.html',
        mimeType: 'text/html',
        metadata: { format: 'html' },
      }),
    };

    const response = await request(buildApp(documentService)).get('/api/documents/doc-empty/download?inline=1');

    expect(response.status).toBe(410);
    expect(response.body.error.message).toContain('Document content is no longer available');
  });

  test('returns 404 when a stored document is missing', async () => {
    const documentService = {
      getDocument: jest.fn().mockReturnValue(null),
    };

    const response = await request(buildApp(documentService)).get('/api/documents/missing/download');

    expect(response.status).toBe(404);
  });

  test('lists document blueprints from the service', async () => {
    const documentService = {
      getBlueprints: jest.fn().mockReturnValue([
        { id: 'report', label: 'evidence-led report' },
        { id: 'website-slides', label: 'website slide deck' },
      ]),
    };

    const response = await request(buildApp(documentService)).get('/api/documents/blueprints');

    expect(response.status).toBe(200);
    expect(response.body.blueprints).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'report' }),
      expect.objectContaining({ id: 'website-slides' }),
    ]));
  });

  test('lists templates using normalized available formats', async () => {
    const documentService = {
      getTemplates: jest.fn().mockResolvedValue([
        {
          id: 'website-slides-storyboard',
          name: 'Website Slides Storyboard',
          category: 'creative',
          description: 'Storyboard deck',
          formats: ['pptx'],
          recommendedFormats: ['html', 'pptx'],
        },
      ]),
      getTemplateAvailableFormats: jest.fn().mockReturnValue(['pptx', 'html']),
      buildTemplateMetadata: jest.fn((template) => ({
        id: template.id,
        name: template.name,
        category: template.category,
        description: template.description,
        formats: ['pptx', 'html'],
      })),
      summarizePackSuggestions: jest.fn().mockReturnValue([]),
      templateEngine: {
        getCategories: jest.fn().mockReturnValue(['creative']),
      },
    };

    const response = await request(buildApp(documentService)).get('/api/documents/templates');

    expect(response.status).toBe(200);
    expect(response.body.templates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'website-slides-storyboard',
        formats: ['pptx', 'html'],
        recommendedFormats: ['pptx', 'html'],
      }),
    ]));
  });

  test('lists supported formats with production capabilities', async () => {
    const documentService = {
      getSupportedFormats: jest.fn().mockReturnValue([
        { id: 'html', name: 'HTML Document', generator: 'custom-html-renderer' },
        { id: 'pdf', name: 'PDF Document', generator: 'browser-html-pdf' },
      ]),
      getDocumentProductionCapabilities: jest.fn().mockReturnValue({
        policy: {
          templateUse: 'Use templates as curated starting structures, not final canned output.',
        },
        suiteActions: [
          { id: 'generate-suite', computeTools: ['document-workflow', 'graph-diagram', 'code-sandbox'] },
        ],
      }),
    };

    const response = await request(buildApp(documentService)).get('/api/documents/formats');

    expect(response.status).toBe(200);
    expect(response.body.formats).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pdf', generator: 'browser-html-pdf' }),
    ]));
    expect(response.body.productionCapabilities.suiteActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'generate-suite',
        computeTools: expect.arrayContaining(['graph-diagram', 'code-sandbox']),
      }),
    ]));
  });

  test('returns workflow recommendations for a document request', async () => {
    const documentService = {
      recommendDocumentWorkflow: jest.fn().mockReturnValue({
        inferredType: 'pitch-deck',
        pipeline: 'presentation',
        recommendedFormat: 'pptx',
        recommendedTemplates: [{ id: 'pitch-deck-story', name: 'Pitch Deck Story' }],
      }),
    };

    const response = await request(buildApp(documentService))
      .post('/api/documents/recommend')
      .send({
        prompt: 'Create an investor pitch deck',
        format: 'pptx',
      });

    expect(response.status).toBe(200);
    expect(documentService.recommendDocumentWorkflow).toHaveBeenCalled();
    expect(response.body.recommendation).toEqual(expect.objectContaining({
      inferredType: 'pitch-deck',
      recommendedFormat: 'pptx',
    }));
  });

  test('returns a deterministic production plan for the request', async () => {
    const documentService = {
      buildDocumentPlan: jest.fn().mockReturnValue({
        inferredType: 'website-slides',
        outlineType: 'slides',
        titleSuggestion: 'Launch Story',
        outline: [{ index: 1, layout: 'title', title: 'Title Slide' }],
      }),
    };

    const response = await request(buildApp(documentService))
      .post('/api/documents/plan')
      .send({
        prompt: 'Build website slides for our launch',
        format: 'html',
      });

    expect(response.status).toBe(200);
    expect(documentService.buildDocumentPlan).toHaveBeenCalled();
    expect(response.body.plan).toEqual(expect.objectContaining({
      inferredType: 'website-slides',
      outlineType: 'slides',
    }));
  });

  test('injects template store context for ai document generation', async () => {
    const documentService = {
      buildDocumentPlan: jest.fn().mockReturnValue({
        inferredType: 'executive-brief',
        outlineType: 'document',
      }),
      aiGenerate: jest.fn().mockResolvedValue({
        id: 'doc-1',
        filename: 'brief.html',
        mimeType: 'text/html',
        size: 1234,
        metadata: { format: 'html' },
        preview: [],
      }),
    };
    const app = buildApp(documentService);
    app.locals.templateStore = {
      buildPromptContext: jest.fn().mockReturnValue({
        context: '[Reference pattern library]\n- Executive Brief [executive-brief]',
        matches: [{ id: 'executive-brief', name: 'Executive Brief' }],
      }),
      noteTemplateUse: jest.fn().mockResolvedValue(undefined),
    };

    const response = await request(app)
      .post('/api/documents/ai-generate')
      .send({
        prompt: 'Write an executive brief for Q2 priorities',
      });

    expect(response.status).toBe(200);
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      'Write an executive brief for Q2 priorities',
      expect.objectContaining({
        format: 'html',
        templateContext: expect.stringContaining('[Reference pattern library]'),
      }),
    );
    expect(response.body.templateMatches).toEqual([
      expect.objectContaining({ id: 'executive-brief' }),
    ]);
  });

  test('routes non-presentation html ai generation through the structured document pipeline', async () => {
    const documentService = {
      buildDocumentPlan: jest.fn().mockReturnValue({
        inferredType: 'report',
        outlineType: 'document',
        blueprint: { id: 'report' },
        selectedDesignOption: { id: 'briefing-grid', label: 'Briefing Grid' },
      }),
      aiGenerate: jest.fn().mockResolvedValue({
        id: 'doc-html-1',
        filename: 'visual-brief.html',
        mimeType: 'text/html',
        size: 2048,
        metadata: {
          format: 'html',
          title: 'Visual Brief',
          renderEngine: 'browser-html',
        },
        preview: {
          type: 'html',
          content: '<!DOCTYPE html><html><body><h1>Visual Brief</h1></body></html>',
        },
        previewHtml: '<!DOCTYPE html><html><body><h1>Visual Brief</h1></body></html>',
        extractedText: 'Visual Brief',
      }),
    };
    const runtimeArtifactService = {
      generateArtifact: jest.fn(),
    };

    const response = await request(buildApp(documentService, {
      artifactService: runtimeArtifactService,
    }))
      .post('/api/documents/ai-generate')
      .send({
        prompt: 'Create a visual HTML brief with multiple images for the campaign launch.',
        format: 'html',
        documentType: 'report',
        designOptionId: 'briefing-grid',
        tone: 'professional',
        length: 'medium',
        style: 'executive',
        options: {
          theme: 'editorial',
        },
      });

    expect(response.status).toBe(200);
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      'Create a visual HTML brief with multiple images for the campaign launch.',
      expect.objectContaining({
        documentType: 'report',
        format: 'html',
        designOptionId: 'briefing-grid',
        templateContext: expect.any(String),
        designPlan: expect.objectContaining({
          blueprint: expect.objectContaining({ id: 'report' }),
          selectedDesignOption: expect.objectContaining({ id: 'briefing-grid' }),
        }),
      }),
    );
    expect(runtimeArtifactService.generateArtifact).not.toHaveBeenCalled();
    expect(response.body.document).toEqual(expect.objectContaining({
      id: 'doc-html-1',
      filename: 'visual-brief.html',
      mimeType: 'text/html',
      size: 2048,
      metadata: expect.objectContaining({
        format: 'html',
        title: 'Visual Brief',
        renderEngine: 'browser-html',
      }),
    }));
    expect(response.body.downloadUrl).toBe('/api/documents/doc-html-1/download');
  });

  test('keeps html presentation requests on the document service pipeline', async () => {
    const documentService = {
      buildDocumentPlan: jest.fn().mockReturnValue({
        inferredType: 'website-slides',
        outlineType: 'slides',
        blueprint: { id: 'website-slides' },
      }),
      shouldUsePresentationPipeline: jest.fn().mockReturnValue(true),
      aiGenerate: jest.fn().mockResolvedValue({
        id: 'doc-2',
        filename: 'website-slides.html',
        mimeType: 'text/html',
        size: 1234,
        metadata: { format: 'html' },
        preview: [],
      }),
    };
    const runtimeArtifactService = {
      generateArtifact: jest.fn(),
    };

    const response = await request(buildApp(documentService, {
      artifactService: runtimeArtifactService,
    }))
      .post('/api/documents/ai-generate')
      .send({
        prompt: 'Create website slides for the launch story.',
        format: 'html',
        documentType: 'website-slides',
      });

    expect(response.status).toBe(200);
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      'Create website slides for the launch story.',
      expect.objectContaining({
        documentType: 'website-slides',
        format: 'html',
      }),
    );
    expect(runtimeArtifactService.generateArtifact).not.toHaveBeenCalled();
    expect(response.body.downloadUrl).toBe('/api/documents/doc-2/download');
  });

  test('persists session-linked pptx ai generation into the artifact store', async () => {
    sessionStore.get.mockResolvedValue({
      id: 'session-1',
      metadata: {},
    });
    const documentService = {
      buildDocumentPlan: jest.fn().mockReturnValue({
        inferredType: 'presentation',
        outlineType: 'slides',
        blueprint: { id: 'presentation' },
      }),
      aiGenerate: jest.fn().mockResolvedValue({
        id: 'doc-pptx-1',
        filename: 'launch-story.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 4096,
        metadata: { format: 'pptx', slideCount: 6 },
        contentBuffer: Buffer.from('pptx-buffer'),
        preview: {
          type: 'html',
          content: '<!DOCTYPE html><html><body><h1>Launch Story</h1></body></html>',
        },
        previewHtml: '<!DOCTYPE html><html><body><h1>Launch Story</h1></body></html>',
        extractedText: 'Launch Story',
      }),
    };
    const runtimeArtifactService = {
      generateArtifact: jest.fn(),
      createStoredArtifact: jest.fn().mockResolvedValue({
        id: 'artifact-pptx-1',
        filename: 'launch-story.pptx',
        extension: 'pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        sizeBytes: 4096,
        previewHtml: '<!DOCTYPE html><html><body><h1>Launch Story</h1></body></html>',
        metadata: { format: 'pptx', slideCount: 6 },
      }),
      serializeArtifact: jest.fn().mockReturnValue({
        id: 'artifact-pptx-1',
        filename: 'launch-story.pptx',
        format: 'pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        sizeBytes: 4096,
        downloadUrl: '/api/artifacts/artifact-pptx-1/download',
        previewUrl: '/api/artifacts/artifact-pptx-1/preview',
        preview: {
          type: 'html',
          content: '<!DOCTYPE html><html><body><h1>Launch Story</h1></body></html>',
        },
        metadata: { format: 'pptx', slideCount: 6 },
      }),
    };

    const response = await request(buildApp(documentService, {
      artifactService: runtimeArtifactService,
    }))
      .post('/api/documents/ai-generate')
      .send({
        sessionId: 'session-1',
        prompt: 'Build a launch presentation.',
        format: 'pptx',
        documentType: 'presentation',
      });

    expect(response.status).toBe(200);
    expect(documentService.aiGenerate).toHaveBeenCalledWith(
      'Build a launch presentation.',
      expect.objectContaining({
        documentType: 'presentation',
        format: 'pptx',
      }),
    );
    expect(runtimeArtifactService.createStoredArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      sourceMode: 'document-ai',
      filename: 'launch-story.pptx',
      extension: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      previewHtml: expect.stringContaining('Launch Story'),
      extractedText: 'Launch Story',
    }));
    expect(response.body.document).toEqual(expect.objectContaining({
      id: 'artifact-pptx-1',
      filename: 'launch-story.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      metadata: expect.objectContaining({
        format: 'pptx',
        slideCount: 6,
      }),
      preview: expect.objectContaining({
        type: 'html',
      }),
    }));
    expect(response.body.downloadUrl).toBe('/api/artifacts/artifact-pptx-1/download');
  });

  test('returns pptx bytes from the active presentation response after artifact persistence', async () => {
    sessionStore.get.mockResolvedValue({
      id: 'session-1',
      metadata: {},
    });
    const pptxBuffer = Buffer.from('PK\u0003\u0004pptx-buffer', 'latin1');
    const documentService = {
      generatePresentation: jest.fn().mockResolvedValue({
        id: 'doc-pptx-1',
        filename: 'launch-story.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: pptxBuffer.length,
        metadata: { format: 'pptx', slideCount: 6 },
        contentBuffer: pptxBuffer,
        previewHtml: '<!DOCTYPE html><html><body><h1>Launch Story</h1></body></html>',
        extractedText: 'Launch Story',
      }),
    };
    const runtimeArtifactService = {
      createStoredArtifact: jest.fn().mockResolvedValue({
        id: 'artifact-pptx-1',
        filename: 'launch-story.pptx',
        extension: 'pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        sizeBytes: pptxBuffer.length,
        metadata: { format: 'pptx', slideCount: 6 },
      }),
      serializeArtifact: jest.fn().mockReturnValue({
        id: 'artifact-pptx-1',
        filename: 'launch-story.pptx',
        format: 'pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        sizeBytes: pptxBuffer.length,
        downloadUrl: '/api/artifacts/artifact-pptx-1/download',
        metadata: { format: 'pptx', slideCount: 6 },
      }),
    };
    const parseBinaryResponse = (res, callback) => {
      res.setEncoding('binary');
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        callback(null, Buffer.from(data, 'binary'));
      });
    };

    const response = await request(buildApp(documentService, {
      artifactService: runtimeArtifactService,
    }))
      .post('/api/documents/presentation')
      .buffer(true)
      .parse(parseBinaryResponse)
      .send({
        sessionId: 'session-1',
        content: 'Build a launch presentation.',
        title: 'Launch Story',
        format: 'pptx',
      });

    expect(response.status).toBe(200);
    expect(response.header['content-type']).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(response.header['x-artifact-id']).toBe('artifact-pptx-1');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(response.body.equals(pptxBuffer)).toBe(true);
    expect(runtimeArtifactService.createStoredArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      sourceMode: 'document-presentation',
      buffer: pptxBuffer,
    }));
  });

  test('converts a stored generated document through the document service', async () => {
    const documentService = {
      convertStoredDocument: jest.fn().mockResolvedValue({
        id: 'doc-md-1',
        filename: 'brief.md',
        mimeType: 'text/markdown',
        size: 512,
        metadata: {
          format: 'md',
          convertedFrom: 'html',
          sourceDocumentId: 'doc-html-1',
        },
        preview: null,
        downloadUrl: '/api/documents/doc-md-1/download',
      }),
    };

    const response = await request(buildApp(documentService))
      .post('/api/documents/convert')
      .send({
        documentId: 'doc-html-1',
        toFormat: 'markdown',
      });

    expect(response.status).toBe(200);
    expect(documentService.convertStoredDocument).toHaveBeenCalledWith('doc-html-1', 'md');
    expect(response.body.document).toEqual(expect.objectContaining({
      id: 'doc-md-1',
      filename: 'brief.md',
      format: 'md',
      metadata: expect.objectContaining({
        convertedFrom: 'html',
        sourceDocumentId: 'doc-html-1',
      }),
    }));
    expect(response.body.downloadUrl).toBe('/api/documents/doc-md-1/download');
  });
});

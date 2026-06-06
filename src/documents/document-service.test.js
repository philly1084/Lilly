jest.mock('../artifacts/artifact-renderer', () => {
  const actual = jest.requireActual('../artifacts/artifact-renderer');
  return {
    ...actual,
    renderPdfViaBrowser: jest.fn(),
  };
});

const { renderPdfViaBrowser } = require('../artifacts/artifact-renderer');
const { DocumentService } = require('./document-service');
const { resolveDocumentTheme } = require('./document-design-engine');

describe('DocumentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    renderPdfViaBrowser.mockResolvedValue(null);
  });

  test('generates html documents from templates with unique filenames', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const document = await service.generateFromTemplate('business-letter', {
      sender_name: 'Alice Example',
      recipient_name: 'Bob Example',
      subject: 'Quarterly planning',
      body: 'Hello Bob.\n\nHere is the current plan.',
    }, 'html');

    expect(document.filename).toMatch(/\.html$/);
    expect(document.filename).toMatch(/-[a-z0-9]{4,}\.html$/);
    expect(String(document.content)).toContain('<!DOCTYPE html>');
    expect(String(document.content)).toContain('document-hero');
    expect(String(document.content)).toContain('Production Lens');
  });

  test('renders html sections when table payload is null', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    expect(() => service.renderSectionHtml({
      heading: 'Findings',
      content: 'Summary',
      table: null,
    }, {
      layout: 'narrative',
      number: '1',
      anchor: 'findings',
    })).not.toThrow();
  });

  test('renders PDF print CSS with large portrait geometry and clean section dividers', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const css = service.renderDocumentStyles(resolveDocumentTheme('editorial'));

    expect(css).toContain('@page');
    expect(css).toContain('size: 11.33in 14.67in portrait');
    expect(css).toContain('html, body { width: 11.33in; min-height: 14.67in;');
    expect(css).toContain('border-top: 1px solid var(--doc-print-border) !important');
    expect(css).toContain('.document-flow > .document-section:first-child');
  });

  test('uses browser-rendered HTML as the primary PDF pipeline for structured documents', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    renderPdfViaBrowser.mockResolvedValue(Buffer.from('browser-pdf-bytes'));
    jest.spyOn(service.generators.pdf, 'generateFromContent').mockResolvedValue({
      buffer: Buffer.from('pdf-bytes'),
      metadata: {
        format: 'pdf',
        design: {
          blueprint: 'executive-brief',
          theme: 'executive',
          outlineItems: 3,
        },
      },
    });

    const document = await service.generateFromTemplate('executive-brief', {
      title: 'Q2 Decision Brief',
      subtitle: 'Expansion review',
      audience: 'Leadership',
      headline_summary: 'Approve the expansion plan.',
      current_state: 'Pipeline is ahead of target.',
      recommendation: 'Fund the launch and assign an owner.',
      key_metrics: 'Revenue growth: 18%\nCAC payback: 7 months',
      next_steps: 'Approve budget\nAssign owner',
    }, 'pdf', {
      tone: 'professional',
      length: 'medium',
    });

    expect(renderPdfViaBrowser).toHaveBeenCalledWith(
      expect.stringContaining('<!DOCTYPE html>'),
      'Q2 Decision Brief',
      expect.objectContaining({
        designPlan: expect.objectContaining({
          blueprint: expect.objectContaining({ id: 'executive-brief' }),
        }),
      }),
    );
    expect(service.generators.pdf.generateFromContent).not.toHaveBeenCalled();
    expect(document.metadata).toEqual(expect.objectContaining({
      renderEngine: 'browser-html',
      sourceHtml: expect.stringContaining('<!DOCTYPE html>'),
      design: expect.objectContaining({
        blueprint: 'executive-brief',
        theme: 'executive',
      }),
    }));
    expect(document.previewHtml).toContain('document-shell');
  });

  test('falls back to the PDF generator when browser PDF export is unavailable', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    renderPdfViaBrowser.mockResolvedValue(null);
    jest.spyOn(service.generators.pdf, 'generateFromContent').mockResolvedValue({
      buffer: Buffer.from('pdf-bytes'),
      metadata: {
        format: 'pdf',
        design: {
          blueprint: 'executive-brief',
          theme: 'executive',
          outlineItems: 3,
        },
      },
    });

    const document = await service.generateFromTemplate('executive-brief', {
      title: 'Q2 Decision Brief',
      subtitle: 'Expansion review',
      audience: 'Leadership',
      headline_summary: 'Approve the expansion plan.',
      current_state: 'Pipeline is ahead of target.',
      recommendation: 'Fund the launch and assign an owner.',
      key_metrics: 'Revenue growth: 18%\nCAC payback: 7 months',
      next_steps: 'Approve budget\nAssign owner',
    }, 'pdf', {
      tone: 'professional',
      length: 'medium',
    });

    expect(service.generators.pdf.generateFromContent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Q2 Decision Brief',
        documentType: 'executive-brief',
      }),
      expect.objectContaining({
        designPlan: expect.objectContaining({
          blueprint: expect.objectContaining({ id: 'executive-brief' }),
          theme: expect.objectContaining({ id: 'executive' }),
        }),
        sourceHtml: expect.stringContaining('<!DOCTYPE html>'),
      }),
    );
    expect(document.metadata).toEqual(expect.objectContaining({
      renderEngine: 'pdfmake',
      sourceHtml: expect.stringContaining('<!DOCTYPE html>'),
    }));
    expect(document.metadata.design).toEqual(expect.objectContaining({
      blueprint: 'executive-brief',
      theme: 'executive',
    }));
  });

  test('stores generated presentations for later download', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    jest.spyOn(service.aiGenerator, 'generatePresentationContent').mockResolvedValue({
      title: 'Launch Story',
      theme: 'executive',
      slides: [
        { layout: 'title', title: 'Launch Story', subtitle: 'Q2' },
        { layout: 'content', title: 'Momentum', bullets: ['Pipeline is growing'] },
      ],
    });
    jest.spyOn(service.generators.pptx, 'generateFromContent').mockResolvedValue({
      buffer: Buffer.from('pptx-bytes'),
      metadata: { slideCount: 2, theme: 'executive' },
    });

    const document = await service.aiGenerate('Build a launch presentation', {
      format: 'pptx',
      documentType: 'presentation',
      theme: 'executive',
    });

    expect(service.aiGenerator.generatePresentationContent).toHaveBeenCalled();
    expect(service.generators.pptx.generateFromContent).toHaveBeenCalled();
    expect(document.mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(document.filename).toMatch(/\.pptx$/);
    expect(document.downloadUrl).toBe(`/api/documents/${document.id}/download`);
    expect(service.getDocument(document.id)?.contentBuffer).toEqual(Buffer.from('pptx-bytes'));
  });

  test('renders website slides as html presentation decks', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    jest.spyOn(service.aiGenerator, 'generatePresentationContent').mockResolvedValue({
      title: 'Website Deck',
      subtitle: 'Narrative site slides',
      theme: 'product',
      slides: [
        { layout: 'title', title: 'Website Deck', subtitle: 'Narrative site slides' },
        {
          layout: 'chart',
          title: 'Growth',
          chart: {
            title: 'Growth',
            series: [
              { label: 'Jan', value: 12 },
              { label: 'Feb', value: 18 },
            ],
          },
        },
      ],
    });

    const document = await service.generatePresentation('Create website slides', {
      format: 'html',
      theme: 'product',
    });

    expect(document.mimeType).toBe('text/html');
    expect(document.filename).toMatch(/\.html$/);
    expect(String(document.content)).toContain('presentation-deck');
    expect(String(document.content)).toContain('size: 13.333in 7.5in landscape');
    expect(String(document.content)).toContain('Website Slides');
  });

  test('renders verified image urls inside html presentation decks', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const document = await service.generatePresentation({
      title: 'Visual Deck',
      subtitle: 'Verified imagery',
      theme: 'editorial',
      slides: [
        { layout: 'title', title: 'Visual Deck', subtitle: 'Verified imagery' },
        {
          layout: 'image',
          title: 'Waterfront',
          imageUrl: 'https://images.example.com/halifax.jpg',
          imageAlt: 'Halifax waterfront',
          imageSource: 'Jane Doe / Unsplash',
          bullets: ['Verified image source is embedded directly'],
        },
      ],
    }, {
      format: 'html',
      generateImages: false,
    });

    expect(document.mimeType).toBe('text/html');
    expect(String(document.content)).toContain('https://images.example.com/halifax.jpg');
    expect(String(document.content)).toContain('Halifax waterfront');
    expect(String(document.content)).toContain('Jane Doe / Unsplash');
  });

  test('renders template-driven website slides as html presentation decks', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const document = await service.generateFromTemplate('website-slides-storyboard', {
      title: 'Launch Storyboard',
      subtitle: 'Narrative launch site',
      slides: [
        {
          kicker: 'Hero',
          title: 'Design moves at the speed of thought',
          content: 'A visual-first opening scene for the launch.',
          imagePrompt: 'Immersive product hero',
        },
        {
          kicker: 'Proof',
          title: 'Built for teams shipping every day',
          bullets: ['Narrative-first scenes', 'Visual rhythm', 'Strong CTA'],
        },
      ],
    }, 'html', {
      theme: 'product',
    });

    expect(document.mimeType).toBe('text/html');
    expect(document.filename).toMatch(/\.html$/);
    expect(String(document.content)).toContain('presentation-deck');
    expect(String(document.content)).toContain('Launch Storyboard');
    expect(String(document.content)).toContain('Design moves at the speed of thought');
  });

  test('generates xlsx workbooks with section and chart sheets for structured reports', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const document = await service.generateFromTemplate('data-story-report', {
      title: 'Calgary Activity Pulse',
      timeframe: 'April 2026',
      headline_insight: 'Riverfront activity and downtown foot traffic are leading the week.',
      data_points: 'River paths: 82\nMuseums: 61\nNeighborhood food stops: 74',
      drivers: 'Mild weather and concentrated downtown cultural venues keep movement easy.',
      comparisons: 'Bow River loop vs. museum day\nInglewood vs. Kensington evening mix',
      recommendations: 'Book one anchor activity per day\nLeave river timing flexible for weather',
    }, 'xlsx');

    expect(document.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(document.filename).toMatch(/\.xlsx$/);
    expect(document.metadata).toEqual(expect.objectContaining({
      sheetCount: expect.any(Number),
      sheets: expect.arrayContaining(['Overview', 'Sections', 'Topline Insight Chart']),
    }));
    expect(document.previewHtml).toContain('Topline Insight Chart');
    expect(document.extractedText).toContain('River paths');
  });

  test('discovers premium built-in templates for briefs, data stories, and decks', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const templateIds = (await service.getTemplates()).map((template) => template.id);

    expect(templateIds).toEqual(expect.arrayContaining([
      'executive-brief',
      'pitch-deck-story',
      'data-story-report',
      'website-slides-storyboard',
      'board-update-deck',
      'product-roadmap-deck',
      'training-workshop-deck',
      'training-manual-package',
      'training-curriculum-workbook',
      'training-podcast-brief',
      'case-study-deck',
      'conference-keynote-deck',
      'campaign-storyboard-deck',
    ]));
  });

  test('recommends pitch-deck workflow for investor prompts', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const recommendation = service.recommendDocumentWorkflow({
      prompt: 'Create an investor pitch deck for our AI workflow startup',
      format: 'pptx',
    });

    expect(recommendation.inferredType).toBe('pitch-deck');
    expect(recommendation.pipeline).toBe('presentation');
    expect(recommendation.recommendedFormat).toBe('pptx');
    expect(recommendation.recommendedTemplates.map((template) => template.id)).toContain('pitch-deck-story');
  });

  test('recommends training and manuals workflow across package formats', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const recommendation = service.recommendDocumentWorkflow({
      prompt: 'Create a training manual and workbook for onboarding technicians',
      format: 'xlsx',
      limit: 6,
    });

    expect(recommendation.inferredType).toBe('training-manual');
    expect(recommendation.packId).toBe('training-manuals');
    expect(recommendation.recommendedFormat).toBe('xlsx');
    expect(recommendation.recommendedTemplates.map((template) => template.id)).toEqual(expect.arrayContaining([
      'training-manual-package',
      'training-curriculum-workbook',
    ]));
    expect(recommendation.selectedDesignOption).toEqual(expect.objectContaining({
      id: 'learning-path',
    }));
  });

  test('renders training manual templates as learner-centered html', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const document = await service.generateFromTemplate('training-manual-package', {
      title: 'Technician Onboarding',
      audience: 'New field technicians',
      delivery_mode: 'Instructor-led',
      duration: 'Half day',
      prerequisites: 'Basic safety orientation',
      learning_objectives: 'Perform startup checks\nEscalate unsafe conditions',
      module_plan: 'Module 1: Equipment overview\nModule 2: Startup workflow',
      practice_activities: 'Run a mock startup with a partner.',
      assessment: 'Demonstrate checklist completion without prompts.',
      checklist: 'Identify hazards\nComplete startup log',
      facilitator_notes: 'Pause after each module for questions.',
      design_notes: 'Use practical field examples and clear checkpoints.',
    }, 'html');

    expect(document.mimeType).toBe('text/html');
    expect(String(document.content)).toContain('Learning Path');
    expect(String(document.content)).toContain('Learning Objectives');
    expect(String(document.content)).toContain('New field technicians');
    expect(document.metadata.design).toEqual(expect.objectContaining({
      blueprint: 'training-manual',
      layout: 'learning-path',
    }));
  });

  test('keeps html-capable storyboard templates in recommendations for website slides', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const recommendation = service.recommendDocumentWorkflow({
      prompt: 'Build website slides for our product launch story',
      documentType: 'website-slides',
      format: 'html',
    });

    expect(recommendation.recommendedFormat).toBe('html');
    expect(recommendation.recommendedTemplates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'website-slides-storyboard',
        formats: expect.arrayContaining(['html', 'pptx']),
      }),
      expect.objectContaining({
        id: 'campaign-storyboard-deck',
        formats: expect.arrayContaining(['html', 'pptx']),
      }),
    ]));
  });

  test('defaults website-slide recommendations to pptx when no format is requested', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const recommendation = service.recommendDocumentWorkflow({
      prompt: 'Build website slides for our product launch story',
      documentType: 'website-slides',
    });

    expect(recommendation.recommendedFormat).toBe('pptx');
    expect(recommendation.recommendedFormats).toEqual(['pptx', 'html']);
    expect(recommendation.pipeline).toBe('presentation');
  });

  test('recommends a broader pool of templates for general presentation prompts', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const recommendation = service.recommendDocumentWorkflow({
      prompt: 'Build a presentation for our quarterly company update',
      documentType: 'presentation',
      format: 'pptx',
      limit: 8,
    });

    expect(recommendation.recommendedTemplates.length).toBeGreaterThanOrEqual(5);
    expect(recommendation.recommendedTemplates.map((template) => template.id)).toEqual(expect.arrayContaining([
      'presentation-bullet-points',
      'board-update-deck',
      'product-roadmap-deck',
      'training-workshop-deck',
      'case-study-deck',
      'conference-keynote-deck',
    ]));
  });

  test('builds a website-slide production plan with slide outline items', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const plan = service.buildDocumentPlan({
      prompt: 'Build website slides for our product launch story',
      documentType: 'website-slides',
      format: 'html',
    });

    expect(plan.inferredType).toBe('website-slides');
    expect(plan.outlineType).toBe('slides');
    expect(plan.recommendedFormat).toBe('html');
    expect(plan.outline[0]).toEqual(expect.objectContaining({
      layout: 'title',
      title: 'Title Slide',
    }));
    expect(plan.creativeDirection).toEqual(expect.objectContaining({
      id: expect.any(String),
      label: expect.any(String),
    }));
    expect(plan.themeSuggestion).toEqual(expect.any(String));
    expect(plan.humanizationNotes.length).toBeGreaterThan(0);
    expect(plan.qualityStandard).toEqual(expect.objectContaining({
      version: 'document-quality-2026-05-k26-creation-loop',
      creationLoop: expect.arrayContaining([
        expect.objectContaining({ id: 'intent-lock' }),
        expect.objectContaining({ id: 'handoff-proof' }),
      ]),
      agentPasses: expect.arrayContaining([
        expect.objectContaining({ id: 'background-art-director' }),
        expect.objectContaining({ id: 'accessibility-reviewer' }),
      ]),
      backgroundDirection: expect.objectContaining({
        label: expect.stringContaining('background'),
      }),
    }));
    expect(plan.productionToolchain).toEqual(expect.objectContaining({
      customGeneration: true,
      computeTools: expect.arrayContaining(['graph-diagram', 'code-sandbox']),
      qualityPasses: expect.arrayContaining(['background-art-director', 'final-polish-editor']),
      packageTargets: expect.arrayContaining(['vite-preview-bundle']),
    }));
    expect(plan.productionCapabilities.suiteActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'generate-suite',
        computeTools: expect.arrayContaining(['document-workflow', 'graph-diagram', 'code-sandbox']),
      }),
    ]));
  });

  test('advertises compute-backed document production capabilities by format', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const capabilities = service.getDocumentProductionCapabilities();

    expect(capabilities.policy.templateUse).toContain('not final canned output');
    expect(capabilities.policy.qualityStandard).toContain('built-in strategy');
    expect(capabilities.policy.creationLoop).toContain('Kimi K2.6-style creation loop');
    expect(capabilities.policy.userAlignment).toContain('user goal');
    expect(capabilities.formats).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'pdf',
        generator: 'browser-html-pdf',
        toolchain: expect.objectContaining({
          renderPipeline: expect.arrayContaining(['headless-browser-pdf']),
          qualityPasses: expect.arrayContaining(['background-art-director']),
        }),
      }),
      expect.objectContaining({
        id: 'pptx',
        generator: 'pptxgenjs',
        toolchain: expect.objectContaining({
          computeTools: expect.arrayContaining(['image-generation', 'graph-diagram']),
        }),
      }),
      expect.objectContaining({
        id: 'xlsx',
        generator: 'xlsx-workbook-builder',
        toolchain: expect.objectContaining({
          visualCapabilities: expect.arrayContaining(['chart data sheets']),
        }),
      }),
    ]));
  });

  test('builds approved document layout options and honors an explicit selection', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const plan = service.buildDocumentPlan({
      prompt: 'Create an executive brief for our expansion decision',
      documentType: 'executive-brief',
      format: 'html',
      designOptionId: 'briefing-grid',
    });

    expect(plan.designOptions.length).toBeGreaterThan(0);
    expect(plan.selectedDesignOption).toEqual(expect.objectContaining({
      id: 'briefing-grid',
      label: 'Briefing Grid',
    }));
    expect(plan.themeSuggestion).toBe('executive');
  });

  test('renders selected document layout shells for html documents', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const document = await service.generateFromTemplate('executive-brief', {
      title: 'Q2 Decision Brief',
      subtitle: 'Expansion review',
      audience: 'Leadership',
      headline_summary: 'Approve the expansion plan.',
      current_state: 'Pipeline is ahead of target.',
      recommendation: 'Fund the launch and assign an owner.',
      key_metrics: 'Revenue growth: 18%\nCAC payback: 7 months',
      next_steps: 'Approve budget\nAssign owner',
    }, 'html', {
      designPlan: {
        selectedDesignOption: { id: 'briefing-grid' },
        creativeDirection: { id: 'boardroom-brief' },
        themeSuggestion: 'executive',
      },
    });

    expect(String(document.content)).toContain('document-layout-briefing-grid');
    expect(String(document.content)).toContain('--doc-bg-grid');
    expect(document.metadata.design).toEqual(expect.objectContaining({
      layout: 'briefing-grid',
      background: expect.objectContaining({
        id: expect.stringContaining('executive-briefing-grid-background'),
      }),
    }));
  });

  test('renders verified section image urls in html documents', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const document = await service.renderDocument({
      format: 'html',
      title: 'Safety Brief',
      content: {
        title: 'Safety Brief',
        sections: [{
          heading: 'Training Conditions',
          content: 'Weather, currency, and instructor review shape safe operations.',
          imageUrl: 'https://images.example.com/drop-zone.jpg',
          imageAlt: 'Skydiving landing area',
          imageCaption: 'Landing areas should be reviewed before jumping.',
        }],
      },
    });

    expect(String(document.content)).toContain('<figure class="document-image">');
    expect(String(document.content)).toContain('https://images.example.com/drop-zone.jpg');
    expect(String(document.content)).toContain('Skydiving landing area');
  });

  test('treats scaffold-like existing content as structure rather than final copy in production plans', () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const plan = service.buildDocumentPlan({
      prompt: 'Create a polished executive brief about expanding into Atlantic Canada',
      documentType: 'executive-brief',
      format: 'pdf',
      existingContent: '## Overview\n## Details\n{{company_name}}\nPlaceholder copy here',
    });

    expect(plan.sampleHandling).toEqual(expect.arrayContaining([
      expect.stringContaining('Treat the provided template'),
      expect.stringContaining('Do not simply recycle'),
    ]));
  });

  test('assembles multiple source types into a structured html document', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    const document = await service.assemble([
      {
        type: 'notes',
        title: 'Discovery Notes',
        text: '# Insight\nCustomers want faster handoffs.\n\n# Risk\nSupport load may rise.',
      },
      {
        type: 'canvas',
        title: 'Canvas Summary',
        sections: [
          {
            heading: 'Flow',
            content: 'User -> auth -> dashboard',
            bullets: ['Keep login fast'],
          },
        ],
      },
    ], {
      format: 'html',
      title: 'Launch Plan',
    });

    expect(document.mimeType).toBe('text/html');
    expect(String(document.content)).toContain('Source Map');
    expect(String(document.content)).toContain('Discovery Notes');
    expect(String(document.content)).toContain('Insight');
    expect(String(document.content)).toContain('Risk');
    expect(String(document.content)).toContain('User -&gt; auth -&gt; dashboard');
    expect(document.metadata).toEqual(expect.objectContaining({
      assembled: true,
      sourceCount: 2,
      sources: expect.arrayContaining([
        expect.objectContaining({
          title: 'Discovery Notes',
          sectionCount: 2,
        }),
        expect.objectContaining({
          title: 'Canvas Summary',
          sectionCount: 1,
        }),
      ]),
    }));
  });

  test('converts stored html documents to markdown using extracted text', async () => {
    const service = new DocumentService({
      responses: {
        create: jest.fn(),
      },
    });

    service.storeDocument({
      id: 'doc-html-1',
      filename: 'brief.html',
      mimeType: 'text/html',
      metadata: { format: 'html', title: 'Brief' },
      content: '<!DOCTYPE html><html><body><h1>Brief</h1><p>Decision-ready summary.</p></body></html>',
      previewHtml: '<!DOCTYPE html><html><body><h1>Brief</h1><p>Decision-ready summary.</p></body></html>',
      extractedText: '# Brief\nDecision-ready summary.',
    });

    const converted = await service.convertStoredDocument('doc-html-1', 'md');

    expect(converted.mimeType).toBe('text/markdown');
    expect(converted.filename).toMatch(/\.md$/);
    expect(String(converted.content)).toContain('# Brief');
    expect(String(converted.content)).toContain('Decision-ready summary.');
    expect(converted.metadata).toEqual(expect.objectContaining({
      convertedFrom: 'html',
      convertedTo: 'md',
      sourceDocumentId: 'doc-html-1',
    }));
  });
});

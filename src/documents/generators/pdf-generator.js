/**
 * PDF Document Generator
 * Uses pdfmake library for client/server PDF generation
 */
const { resolveDocumentTheme } = require('../document-design-engine');

const DEFAULT_PORTRAIT_PAGE_SIZE = {
  width: 11.33 * 72,
  height: 14.67 * 72,
};
const DEFAULT_PORTRAIT_PAGE_MARGINS = [54, 62, 54, 58];
const DEFAULT_CONTENT_WIDTH = DEFAULT_PORTRAIT_PAGE_SIZE.width
  - DEFAULT_PORTRAIT_PAGE_MARGINS[0]
  - DEFAULT_PORTRAIT_PAGE_MARGINS[2];

class PdfGenerator {
  constructor() {
    this.mimeType = 'application/pdf';
    this.vfs = null;
    this.pdfMake = null;
  }

  /**
   * Initialize pdfmake (for server-side)
   */
  async initialize() {
    if (!this.pdfMake) {
      const pdfMakeModule = require('pdfmake/build/pdfmake');
      const pdfFonts = require('pdfmake/build/vfs_fonts');
      
      this.pdfMake = pdfMakeModule.default || pdfMakeModule;
      this.vfs = pdfFonts.default || pdfFonts;
      
      this.pdfMake.vfs = this.vfs.pdfMake ? this.vfs.pdfMake.vfs : this.vfs;

      if (typeof this.pdfMake.createPdf !== 'function') {
        throw new Error('PDF renderer failed to initialize: pdfmake createPdf API is unavailable');
      }
    }
  }

  async createPdfBuffer(docDefinition) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      try {
        const pdfDocGenerator = this.pdfMake.createPdf(docDefinition);
        pdfDocGenerator.getBuffer((buffer) => {
          if (!buffer || buffer.length === 0) {
            reject(new Error('PDF renderer returned an empty document'));
            return;
          }
          resolve(Buffer.from(buffer));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Generate PDF from template
   * @param {Object} template - Populated template
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generated PDF
   */
  async generate(template, options = {}) {
    const docDefinition = this.buildDocumentDefinition(template, options);
    const buffer = await this.createPdfBuffer(docDefinition);

    return {
      buffer,
      metadata: {
        format: 'pdf',
        pages: docDefinition.content.length
      }
    };
  }

  /**
   * Generate PDF from AI-generated content
   * @param {Object} content - Content structure
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generated PDF
   */
  async generateFromContent(content, options = {}) {
    const docDefinition = this.buildContentDefinition(content, options);
    const buffer = await this.createPdfBuffer(docDefinition);

    return {
      buffer,
      metadata: {
        format: 'pdf',
        title: content.title,
        sections: content.sections?.length || 0,
        design: options.designPlan
          ? {
            blueprint: options.designPlan.blueprint?.id,
            theme: options.designPlan.theme?.id,
            outlineItems: options.designPlan.outline?.length || 0,
          }
          : undefined,
      }
    };
  }

  async generateFromNotesPage(page, options = {}) {
    const docDefinition = this.buildNotesPageDefinition(page, options);
    const buffer = await this.createPdfBuffer(docDefinition);

    return {
      buffer,
      metadata: {
        format: 'pdf',
        title: page?.title || 'Untitled',
        blockCount: Array.isArray(page?.blocks) ? page.blocks.length : 0,
      }
    };
  }

  /**
   * Build document definition from template
   * @param {Object} template - Template data
   * @param {Object} options - Options
   * @returns {Object} pdfmake document definition
   */
  buildDocumentDefinition(template, options) {
    const v = template.variables || {};

    const docDefinition = {
      pageSize: DEFAULT_PORTRAIT_PAGE_SIZE,
      pageMargins: DEFAULT_PORTRAIT_PAGE_MARGINS,
      
      defaultStyle: {
        font: 'Roboto',
        fontSize: 11,
        lineHeight: 1.3
      },

      styles: {
        title: {
          fontSize: 24,
          bold: true,
          margin: [0, 0, 0, 20],
          alignment: 'center'
        },
        heading1: {
          fontSize: 18,
          bold: true,
          margin: [0, 20, 0, 10]
        },
        heading2: {
          fontSize: 14,
          bold: true,
          margin: [0, 15, 0, 8]
        },
        heading3: {
          fontSize: 12,
          bold: true,
          margin: [0, 10, 0, 5]
        },
        paragraph: {
          margin: [0, 0, 0, 10]
        },
        list: {
          margin: [0, 0, 0, 10]
        },
        tableHeader: {
          bold: true,
          fillColor: '#f0f0f0'
        }
      }
    };

    // Build content based on template type
    switch (template.id) {
      case 'business-letter':
        docDefinition.content = this.buildBusinessLetter(v);
        break;
      case 'resume-modern':
        docDefinition.content = this.buildResume(v);
        break;
      case 'meeting-notes':
        docDefinition.content = this.buildMeetingNotes(v);
        break;
      case 'invoice':
        docDefinition.content = this.buildInvoice(v);
        break;
      default:
        docDefinition.content = this.buildGenericContent(v);
    }

    // Add header/footer if requested
    if (options.includePageNumbers) {
      docDefinition.footer = (currentPage, pageCount) => ({
        text: `Page ${currentPage} of ${pageCount}`,
        alignment: 'center',
        fontSize: 9,
        margin: [0, 20, 0, 0]
      });
    }

    return docDefinition;
  }

  /**
   * Build content definition from AI-generated structure
   * @param {Object} content - Content structure
   * @param {Object} options - Options
   * @returns {Object} pdfmake document definition
   */
  buildContentDefinition(content, options = {}) {
    const designPlan = options.designPlan || {};
    const theme = resolveDocumentTheme(designPlan?.theme?.id || content.theme || 'editorial');
    const docContent = [];

    docContent.push(this.buildHeroCard(content, designPlan, theme));

    if (Array.isArray(designPlan.insightCards) && designPlan.insightCards.length > 0) {
      docContent.push(this.buildInsightCardTable(designPlan.insightCards, theme));
    }

    if ((options.includeTableOfContents || designPlan?.pdf?.showOutline) && Array.isArray(designPlan.outline) && designPlan.outline.length > 0) {
      docContent.push(
        { text: 'Document Flow', style: 'eyebrow' },
        {
          ol: designPlan.outline.map((item) => `${item.heading} (${item.layout})`),
          margin: [0, 0, 0, 18],
          color: theme.text,
        }
      );
    }

    // Sections
    if (content.sections) {
      for (let index = 0; index < content.sections.length; index += 1) {
        const section = content.sections[index];
        const sectionPlan = Array.isArray(designPlan.sections) ? designPlan.sections[index] || {} : {};
        docContent.push(this.buildSectionCard(section, sectionPlan, theme, index));
      }
    }

    return {
      pageSize: designPlan?.pdf?.pageSize || DEFAULT_PORTRAIT_PAGE_SIZE,
      pageMargins: designPlan?.pdf?.pageMargins || DEFAULT_PORTRAIT_PAGE_MARGINS,
      
      defaultStyle: {
        font: 'Roboto',
        fontSize: 11,
        lineHeight: 1.42,
        color: theme.text,
      },

      styles: {
        title: {
          fontSize: 28,
          bold: true,
          color: theme.text,
          margin: [0, 0, 0, 10],
        },
        heading1: {
          fontSize: 18,
          bold: true,
          color: theme.text,
          margin: [0, 12, 0, 8]
        },
        heading2: {
          fontSize: 14,
          bold: true,
          color: theme.text,
          margin: [0, 10, 0, 6]
        },
        heading3: {
          fontSize: 12,
          bold: true,
          color: theme.text,
          margin: [0, 8, 0, 5]
        },
        eyebrow: {
          fontSize: 9,
          bold: true,
          color: theme.accent,
          margin: [0, 0, 0, 6]
        },
        paragraph: {
          margin: [0, 0, 0, 10]
        },
      },

      content: docContent,

      footer: options.includePageNumbers ? (currentPage, pageCount) => ({
        margin: [46, 10, 46, 0],
        columns: [
          { text: `${content.title || 'Document'} - ${designPlan?.blueprint?.label || 'document'}`, fontSize: 9, color: theme.muted },
          { text: `Page ${currentPage} of ${pageCount}`, alignment: 'right', fontSize: 9, color: theme.muted }
        ]
      }) : undefined
    };
  }

  buildHeroCard(content = {}, designPlan = {}, theme) {
    return {
      table: {
        widths: ['*', 176],
        body: [[
          {
            stack: [
              { text: designPlan?.hero?.eyebrow || designPlan?.blueprint?.label || 'Document', style: 'eyebrow' },
              { text: content.title || designPlan?.title || 'Document', style: 'title' },
              ...(content.subtitle ? [{ text: content.subtitle, color: theme.muted, margin: [0, 0, 0, 10] }] : []),
              { text: designPlan?.hero?.narrative || '', style: 'paragraph' }
            ],
            fillColor: theme.panel,
            margin: [18, 18, 18, 18],
            border: [false, false, false, false]
          },
          {
            stack: [
              { text: 'Design Lens', style: 'eyebrow' },
              { text: designPlan?.hero?.summary || '', bold: true, color: theme.text, margin: [0, 0, 0, 8] },
              { text: designPlan?.blueprint?.goal || '', color: theme.muted },
            ],
            fillColor: theme.panelAlt,
            margin: [14, 18, 14, 18],
            border: [false, false, false, false]
          }
        ]]
      },
      layout: this.createCardLayout(theme.border),
      margin: [0, 0, 0, 18]
    };
  }

  buildInsightCardTable(cards = [], theme) {
    const columns = cards.slice(0, 4).map((card) => ({
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            { text: card.label || 'Metric', style: 'eyebrow' },
            { text: card.value || '', fontSize: 16, bold: true, color: theme.text, margin: [0, 6, 0, 6] },
            { text: card.detail || '', color: theme.muted, fontSize: 9.5 }
          ],
          fillColor: theme.panel,
          margin: [12, 12, 12, 12],
          border: [false, false, false, false]
        }]]
      },
      layout: this.createCardLayout(theme.border)
    }));

    return {
      columns,
      columnGap: 10,
      margin: [0, 0, 0, 18]
    };
  }

  buildSectionCard(section = {}, sectionPlan = {}, theme, index = 0) {
    const nodes = [];
    const styleName = `heading${Math.min(section.level || 1, 3)}`;

    if (section.heading) {
      nodes.push({
        columns: [
          {
            width: 44,
            stack: [
              { text: sectionPlan.number || '', fontSize: 20, bold: true, color: theme.accent },
              { text: sectionPlan.layout || 'narrative', fontSize: 8, color: theme.muted }
            ]
          },
          {
            width: '*',
            stack: [
              { text: section.heading, style: styleName },
            ]
          }
        ],
        columnGap: 8
      });
    }

    nodes.push(...this.buildStructuredSection(section, {
      theme,
    }));

    const stack = [];

    if (index > 0) {
      stack.push(this.buildSectionDivider(theme.border));
    }

    stack.push({
      table: {
        widths: ['*'],
        body: [[{
          stack: nodes,
          fillColor: theme.page,
          margin: [0, 2, 0, 0],
          border: [false, false, false, false]
        }]]
      },
      layout: 'noBorders'
    });

    return {
      stack,
      margin: [0, index > 0 ? 4 : 0, 0, 16]
    };
  }

  buildStructuredSection(section = {}, options = {}) {
    const theme = resolveDocumentTheme(options?.theme?.id || options?.theme || 'editorial');
    const nodes = [];

    if (section.content) {
      nodes.push(...this.parseContent(section.content));
    }

    if (Array.isArray(section.bullets) && section.bullets.length > 0) {
      nodes.push({
        ul: section.bullets.map((bullet) => String(bullet || '')),
        margin: [0, 0, 0, 8]
      });
    }

    const callout = this.normalizeCallout(section.callout);
    if (callout) {
      nodes.push({
        table: {
          widths: ['*'],
          body: [[{
            stack: [
              ...(callout.title ? [{ text: callout.title, bold: true, margin: [0, 0, 0, 6] }] : []),
              { text: callout.body || '' }
            ]
          }]]
        },
        layout: this.createCardLayout(this.getCalloutBorder(callout.tone, theme)),
        margin: [0, 10, 0, 14]
      });
    }

    if (Array.isArray(section.stats) && section.stats.length > 0) {
      nodes.push(this.buildStatsTable(section.stats, theme));
    }

    if (section.table?.headers?.length || section.table?.rows?.length) {
      nodes.push(this.buildDataTable(section.table.headers || [], section.table.rows || [], section.table.caption || '', theme));
    }

    if (section.chart?.series?.length) {
      if (section.chart.title) {
        nodes.push({ text: section.chart.title, style: 'heading3' });
      }
      if (section.chart.summary) {
        nodes.push({ text: section.chart.summary, style: 'paragraph' });
      }
      nodes.push(this.buildDataTable(
        ['Label', 'Value'],
        section.chart.series.map((point) => [point.label || '', String(point.value ?? '')]),
        '',
        theme
      ));
    }

    return nodes;
  }

  getCalloutBorder(tone = 'note', theme) {
    if (tone === 'warning') {
      return theme.warning;
    }

    if (tone === 'highlight') {
      return theme.success;
    }

    return theme.accent;
  }

  normalizeCallout(callout) {
    if (!callout) {
      return null;
    }

    if (typeof callout === 'string') {
      return {
        title: '',
        body: callout,
        tone: 'note',
      };
    }

    return {
      title: callout.title || '',
      body: callout.body || callout.content || callout.text || '',
      tone: callout.tone || 'note',
    };
  }

  buildStatsTable(stats = [], theme) {
    const rows = stats.map((stat) => [
      { text: stat.label || 'Metric', bold: true, color: theme.text },
      { text: stat.value || '' },
      { text: stat.detail || '', color: theme.muted }
    ]);

    return this.buildDataTable(['Metric', 'Value', 'Context'], rows, '', theme);
  }

  buildDataTable(headers = [], rows = [], caption = '', theme = resolveDocumentTheme('editorial')) {
    const safeHeaders = Array.isArray(headers) ? headers : [];
    const safeRows = Array.isArray(rows) ? rows : [];

    return {
      stack: [
        ...(caption ? [{ text: caption, style: 'paragraph', color: theme.muted }] : []),
        {
          table: {
            headerRows: safeHeaders.length > 0 ? 1 : 0,
            widths: safeHeaders.length > 0
              ? safeHeaders.map(() => '*')
              : (safeRows[0] || ['']).map(() => '*'),
            body: [
              ...(safeHeaders.length > 0 ? [safeHeaders.map((header) => ({ text: header, bold: true, fillColor: theme.panelAlt, color: theme.text }))] : []),
              ...safeRows.map((row) => row.map((cell) => ({ text: String(cell ?? '') }))),
            ]
          },
          layout: 'lightHorizontalLines',
          margin: [0, 6, 0, 14]
        }
      ]
    };
  }

  buildNotesPageDefinition(page, options = {}) {
    const safePage = page && typeof page === 'object' ? page : {};
    const blocks = Array.isArray(safePage.blocks) ? safePage.blocks : [];
    const properties = Array.isArray(safePage.properties) ? safePage.properties : [];
    const title = this.safeText(safePage.title) || 'Untitled';
    const titleLine = [this.safeText(safePage.icon), title].filter(Boolean).join(' ');
    const outline = this.collectOutline(blocks);
    const exportedAt = new Date().toLocaleString();
    const updatedAt = safePage.updatedAt || safePage.lastEditedAt || safePage.lastModifiedAt || Date.now();

    const content = [
      { text: 'NOTES EXPORT', style: 'notesEyebrow' },
      { text: titleLine, style: 'notesTitle' },
      {
        columns: [
          {
            width: '*',
            stack: [
              {
                text: this.safeText(safePage.cover)
                  ? 'A clean, print-ready version of your Notes page with nested sections preserved.'
                  : 'A clean, print-ready version of your Notes page with nested sections preserved.',
                style: 'notesSubtitle'
              }
            ]
          },
          {
            width: 180,
            table: {
              widths: ['*'],
              body: [[{
                stack: [
                  {
                    columns: [
                      { width: 64, text: 'Updated', style: 'notesMetaLabel' },
                      { width: '*', text: this.formatDate(updatedAt), style: 'notesMetaValue' }
                    ]
                  },
                  {
                    columns: [
                      { width: 64, text: 'Blocks', style: 'notesMetaLabel' },
                      { width: '*', text: String(this.countBlocks(blocks)), style: 'notesMetaValue' }
                    ],
                    margin: [0, 6, 0, 0]
                  },
                  {
                    columns: [
                      { width: 64, text: 'Exported', style: 'notesMetaLabel' },
                      { width: '*', text: exportedAt, style: 'notesMetaValue' }
                    ],
                    margin: [0, 6, 0, 0]
                  }
                ],
                fillColor: '#F7F8FC',
                margin: [10, 10, 10, 10],
                border: [false, false, false, false]
              }]]
            },
            layout: this.createCardLayout('#D8E1F0')
          }
        ],
        columnGap: 20,
        margin: [0, 0, 0, 20]
      }
    ];

    if (properties.length > 0) {
      content.push({ text: 'Page Properties', style: 'notesSectionLabel' });
      content.push(this.buildNotesPropertiesTable(properties));
    }

    if (outline.length >= 3 && options.includeOutline !== false) {
      content.push({ text: 'Contents', style: 'notesSectionLabel' });
      content.push({
        table: {
          widths: ['*'],
          body: outline.map((item) => ([{
            text: `${'  '.repeat(Math.min(item.depth || 0, 3))}${item.text}`,
            color: '#30425A',
            margin: [8, 3, 8, 3],
            border: [false, false, false, false]
          }]))
        },
        layout: this.createCardLayout('#D8E1F0'),
        margin: [0, 0, 0, 16],
      });
    }

    content.push({
      canvas: [{
        type: 'line',
        x1: 0,
        y1: 0,
        x2: DEFAULT_CONTENT_WIDTH,
        y2: 0,
        lineWidth: 1,
        lineColor: '#D8E1F0'
      }],
      margin: [0, 0, 0, 18]
    });

    content.push(...this.buildNotesBlocks(blocks, 0));

    if (content.length <= 4) {
      content.push({
        text: 'This page is currently empty.',
        style: 'notesMuted'
      });
    }

    return {
      pageSize: DEFAULT_PORTRAIT_PAGE_SIZE,
      pageMargins: DEFAULT_PORTRAIT_PAGE_MARGINS,
      defaultStyle: {
        font: 'Roboto',
        fontSize: 11,
        lineHeight: 1.45,
        color: '#1F2937'
      },
      styles: {
        notesEyebrow: {
          fontSize: 9,
          bold: true,
          color: '#4D6682',
          characterSpacing: 1.2,
          margin: [0, 0, 0, 6]
        },
        notesTitle: {
          fontSize: 28,
          bold: true,
          color: '#101E33',
          margin: [0, 0, 0, 8]
        },
        notesSubtitle: {
          fontSize: 11,
          color: '#42556B',
          margin: [0, 2, 0, 0]
        },
        notesSectionLabel: {
          fontSize: 10,
          bold: true,
          color: '#4D6682',
          margin: [0, 12, 0, 8]
        },
        notesHeading1: {
          fontSize: 20,
          bold: true,
          color: '#101E33',
          margin: [0, 20, 0, 10]
        },
        notesHeading2: {
          fontSize: 15.5,
          bold: true,
          color: '#183557',
          margin: [0, 16, 0, 8]
        },
        notesHeading3: {
          fontSize: 12.5,
          bold: true,
          color: '#25527A',
          margin: [0, 12, 0, 6]
        },
        notesParagraph: {
          margin: [0, 0, 0, 8]
        },
        notesListItem: {
          margin: [0, 0, 0, 4]
        },
        notesCodeLabel: {
          fontSize: 9,
          bold: true,
          color: '#64748B',
          margin: [0, 0, 0, 4]
        },
        notesCode: {
          fontSize: 9,
          color: '#E5EEF8'
        },
        notesMetaLabel: {
          fontSize: 9,
          bold: true,
          color: '#62748A'
        },
        notesMetaValue: {
          fontSize: 9,
          color: '#213247'
        },
        notesMuted: {
          fontSize: 10,
          color: '#6B7280',
          italics: true,
          margin: [0, 0, 0, 8]
        },
        notesLinkTitle: {
          color: '#0F4C81',
          bold: true
        },
        notesLinkUrl: {
          fontSize: 9,
          color: '#3B82F6'
        },
        notesImageCaption: {
          fontSize: 10,
          color: '#334155',
          margin: [0, 0, 0, 3]
        },
        notesImageSubtext: {
          fontSize: 9,
          color: '#64748B',
          italics: true,
          margin: [0, 0, 0, 2]
        }
      },
      content,
      footer: (currentPage, pageCount) => ({
        margin: [48, 10, 48, 0],
        columns: [
          { text: `${title} - PDF export`, fontSize: 9, color: '#6B7280' },
          { text: `Page ${currentPage} of ${pageCount}`, alignment: 'right', fontSize: 9, color: '#6B7280' }
        ]
      })
    };
  }

  buildNotesPropertiesTable(properties = []) {
    const rows = properties
      .filter((property) => property && (property.key || property.value))
      .map((property) => ([
        { text: this.safeText(property.key), bold: true, color: '#334155' },
        { text: this.safeText(property.value), color: '#1F2937' }
      ]));

    return {
      table: {
        widths: [120, '*'],
        body: rows.length > 0 ? rows : [[{ text: 'No properties', colSpan: 2, color: '#6B7280' }, {}]]
      },
      layout: this.createCardLayout('#E3E8F2'),
      margin: [0, 0, 0, 14]
    };
  }

  buildNotesBlocks(blocks = [], depth = 0) {
    const nodes = [];

    blocks.forEach((block) => {
      nodes.push(...this.buildNotesBlock(block, depth));
    });

    return nodes;
  }

  buildNotesBlock(block, depth = 0) {
    if (!block || typeof block !== 'object') {
      return [];
    }

    const indent = Math.min(depth * 16, 72);
    const text = this.extractNotesBlockText(block);
    const nodes = [];
    const appendChildren = () => {
      if (Array.isArray(block.children) && block.children.length > 0) {
        nodes.push(...this.buildNotesBlocks(block.children, depth + 1));
      }
    };

    switch (block.type) {
      case 'heading_1':
        if (text) {
          nodes.push({ text, style: 'notesHeading1', margin: [indent, 20, 0, 10] });
        }
        appendChildren();
        return nodes;

      case 'heading_2':
        if (text) {
          nodes.push({ text, style: 'notesHeading2', margin: [indent, 16, 0, 8] });
        }
        appendChildren();
        return nodes;

      case 'heading_3':
        if (text) {
          nodes.push({ text, style: 'notesHeading3', margin: [indent, 12, 0, 6] });
        }
        appendChildren();
        return nodes;

      case 'bulleted_list':
        if (text) {
          nodes.push({ text: `- ${text}`, style: 'notesListItem', margin: [indent + 8, 0, 0, 4] });
        }
        appendChildren();
        return nodes;

      case 'numbered_list':
        if (text) {
          nodes.push({ text: `1. ${text}`, style: 'notesListItem', margin: [indent + 8, 0, 0, 4] });
        }
        appendChildren();
        return nodes;

      case 'todo': {
        const checked = block.content && typeof block.content === 'object' && block.content.checked;
        const todoText = this.safeText(block.content && typeof block.content === 'object' ? block.content.text : block.content);
        if (todoText) {
          nodes.push({ text: `${checked ? '[x]' : '[ ]'} ${todoText}`, style: 'notesListItem', margin: [indent + 8, 0, 0, 5] });
        }
        appendChildren();
        return nodes;
      }

      case 'quote':
        if (text) {
          nodes.push({
            table: {
              widths: [4, '*'],
              body: [[
                { text: '', fillColor: '#8FB3D9', border: [false, false, false, false] },
                {
                  text,
                  italics: true,
                  color: '#334155',
                  fillColor: '#F8FAFC',
                  margin: [12, 10, 10, 10],
                  border: [false, false, false, false]
                }
              ]]
            },
            layout: 'noBorders',
            margin: [indent, 4, 0, 12]
          });
        }
        appendChildren();
        return nodes;

      case 'callout': {
        const palette = this.getColorPalette(block.color || 'yellow');
        const icon = this.safeText(block.icon || block.content?.icon || '!');
        const calloutText = this.safeText(block.content && typeof block.content === 'object' ? block.content.text : block.content);
        if (calloutText) {
          nodes.push({
            table: {
              widths: [22, '*'],
              body: [[
                {
                  text: icon || '!',
                  bold: true,
                  color: palette.accent,
                  fillColor: palette.background,
                  margin: [0, 10, 0, 0],
                  alignment: 'center',
                  border: [false, false, false, false]
                },
                {
                  text: calloutText,
                  fillColor: palette.background,
                  color: '#243447',
                  margin: [0, 10, 12, 10],
                  border: [false, false, false, false]
                }
              ]]
            },
            layout: this.createCardLayout(palette.border),
            margin: [indent, 6, 0, 12]
          });
        }
        appendChildren();
        return nodes;
      }

      case 'code': {
        const codeText = this.safeText(block.content && typeof block.content === 'object' ? block.content.text : block.content);
        const language = this.safeText(block.content && typeof block.content === 'object' ? block.content.language : '');
        if (codeText) {
          nodes.push({
            table: {
              widths: ['*'],
              body: [[{
                stack: [
                  language ? { text: language.toUpperCase(), style: 'notesCodeLabel' } : null,
                  { text: codeText, style: 'notesCode' }
                ].filter(Boolean),
                fillColor: '#0F172A',
                margin: [12, 10, 12, 10],
                border: [false, false, false, false]
              }]]
            },
            layout: this.createCardLayout('#1E293B'),
            margin: [indent, 6, 0, 14]
          });
        }
        appendChildren();
        return nodes;
      }

      case 'divider':
        nodes.push({
          canvas: [{
            type: 'line',
            x1: indent,
            y1: 0,
            x2: DEFAULT_CONTENT_WIDTH,
            y2: 0,
            lineWidth: 1,
            lineColor: '#E2E8F0'
          }],
          margin: [0, 10, 0, 10]
        });
        appendChildren();
        return nodes;

      case 'bookmark': {
        const url = this.safeText(block.content?.url);
        const title = this.safeText(block.content?.title) || url || 'Link';
        const description = this.safeText(block.content?.description);
        if (url || title) {
          nodes.push({
            table: {
              widths: ['*'],
              body: [[{
                stack: [
                  { text: title, style: 'notesLinkTitle', link: url || undefined },
                  description ? { text: description, margin: [0, 4, 0, 0], color: '#475569' } : null,
                  url ? { text: url, style: 'notesLinkUrl', link: url, margin: [0, 6, 0, 0] } : null
                ].filter(Boolean),
                fillColor: '#F8FBFF',
                margin: [12, 10, 12, 10],
                border: [false, false, false, false]
              }]]
            },
            layout: this.createCardLayout('#C7DBF4'),
            margin: [indent, 6, 0, 12]
          });
        }
        appendChildren();
        return nodes;
      }

      case 'image':
      case 'ai_image': {
        const imageExport = this.getNotesImageExport(block);
        const label = block.type === 'ai_image' ? 'AI Image' : 'Image';
        const imageStack = [
          { text: label, style: 'notesCodeLabel' },
        ];

        if (imageExport.image) {
          imageStack.push({
            image: imageExport.image,
            fit: [Math.max(220, DEFAULT_CONTENT_WIDTH - indent - 24), 360],
            alignment: 'center',
            margin: [0, 4, 0, imageExport.caption || imageExport.subtext ? 8 : 0],
          });
        } else {
          imageStack.push({
            text: imageExport.alt || imageExport.caption || 'Image preview unavailable',
            color: '#1F2937',
          });
        }

        if (imageExport.caption) {
          imageStack.push({
            text: imageExport.caption,
            style: 'notesImageCaption',
            alignment: 'center',
          });
        }

        if (imageExport.subtext) {
          imageStack.push({
            text: imageExport.subtext,
            style: 'notesImageSubtext',
            alignment: 'center',
          });
        }

        if (imageExport.link && imageExport.link !== imageExport.image) {
          imageStack.push({
            text: imageExport.link,
            style: 'notesLinkUrl',
            link: imageExport.link,
            alignment: 'center',
            margin: [0, 6, 0, 0],
          });
        }

        nodes.push({
          table: {
            widths: ['*'],
            body: [[{
              stack: imageStack.filter(Boolean),
              fillColor: '#F8FAFC',
              margin: [12, 10, 12, 10],
              border: [false, false, false, false]
            }]]
          },
          layout: this.createCardLayout('#D7E0EA'),
          margin: [indent, 6, 0, 12]
        });
        appendChildren();
        return nodes;
      }

      case 'database': {
        const columns = Array.isArray(block.content?.columns) ? block.content.columns : [];
        const rows = Array.isArray(block.content?.rows) ? block.content.rows : [];
        if (columns.length > 0) {
          const body = [
            columns.map((column) => ({
              text: this.safeText(column),
              bold: true,
              fillColor: '#EAF1FB',
              color: '#1E3A5F'
            })),
            ...rows.map((row) => columns.map((_, index) => this.safeText(Array.isArray(row) ? row[index] : '')))
          ];
          nodes.push({
            table: {
              headerRows: 1,
              widths: columns.map(() => '*'),
              body
            },
            layout: 'lightHorizontalLines',
            margin: [indent, 6, 0, 14]
          });
        }
        appendChildren();
        return nodes;
      }

      case 'chart': {
        const title = this.safeText(block.content?.title || 'Chart');
        const summary = this.safeText(block.content?.summary || block.content?.subtext || block.content?.subtitle);
        const labels = Array.isArray(block.content?.labels) ? block.content.labels : [];
        const values = Array.isArray(block.content?.values) ? block.content.values : [];
        const unit = this.safeText(block.content?.unit);
        if (labels.length > 0 || title) {
          nodes.push({
            stack: [
              { text: title, style: 'notesHeading3' },
              summary ? { text: summary, style: 'notesMuted' } : null,
              labels.length > 0 ? this.buildDataTable(
                ['Label', 'Value'],
                labels.map((label, index) => [
                  this.safeText(label),
                  `${this.safeText(values[index] ?? '')}${unit}`,
                ]),
                '',
                resolveDocumentTheme('editorial')
              ) : null,
            ].filter(Boolean),
            margin: [indent, 6, 0, 12],
          });
        }
        appendChildren();
        return nodes;
      }

      case 'mermaid': {
        const mermaidText = this.safeText(block.content?.text || block.content);
        const diagramType = this.safeText(block.content?.diagramType || 'diagram');
        if (mermaidText) {
          nodes.push({
            table: {
              widths: ['*'],
              body: [[{
                stack: [
                  { text: `Mermaid diagram (${diagramType})`, style: 'notesCodeLabel' },
                  { text: mermaidText, fontSize: 9, color: '#334155' }
                ],
                fillColor: '#F8FAFC',
                margin: [12, 10, 12, 10],
                border: [false, false, false, false]
              }]]
            },
            layout: this.createCardLayout('#D7E0EA'),
            margin: [indent, 6, 0, 12]
          });
        }
        appendChildren();
        return nodes;
      }

      case 'math': {
        const mathText = this.safeText(block.content?.text || block.content?.latex || block.content);
        if (mathText) {
          nodes.push({
            text: mathText,
            fontSize: 10,
            margin: [indent, 2, 0, 10],
            color: '#1D3557'
          });
        }
        appendChildren();
        return nodes;
      }

      case 'toggle':
        if (text) {
          nodes.push({ text: `Toggle: ${text}`, style: 'notesParagraph', margin: [indent, 0, 0, 8], bold: true });
        }
        appendChildren();
        return nodes;

      default:
        if (text) {
          nodes.push({ text, style: 'notesParagraph', margin: [indent, 0, 0, 8] });
        }
        appendChildren();
        return nodes;
    }
  }

  getNotesImageExport(block = {}) {
    const content = block.content && typeof block.content === 'object' ? block.content : {};
    const rawImage = this.safeText(
      content._exportImageDataUrl
      || content._exportImageUrl
      || content.dataUrl
      || content.imageDataUrl
      || content.imageUrl
      || content.url
    );
    const image = this.isPdfEmbeddableDataImage(rawImage) ? rawImage : '';
    const fallbackLink = this.safeText(
      content._exportLink
      || content.downloadUrl
      || content.sourceUrl
      || content.url
      || content.imageUrl
    );
    const caption = this.safeText(
      content._exportCaption
      || content.caption
      || content.title
      || (block.type === 'ai_image' ? content.prompt : '')
    );
    const alt = this.safeText(content._exportAlt || content.alt || caption || content.prompt);
    const subtext = this.safeText(
      content._exportSubtext
      || content.subtext
      || content.subtitle
      || content.description
    );

    return {
      image,
      link: fallbackLink,
      caption,
      subtext,
      alt,
    };
  }

  isPdfEmbeddableDataImage(value) {
    return /^data:image\/(?:png|jpe?g);base64,[a-z0-9+/=]+$/i.test(String(value || '').trim());
  }

  extractNotesBlockText(block) {
    if (!block) return '';
    if (typeof block.content === 'string') return block.content;
    if (!block.content || typeof block.content !== 'object') return '';

    if (typeof block.content.text === 'string') return block.content.text;
    if (typeof block.content.prompt === 'string') return block.content.prompt;
    if (typeof block.content.result === 'string') return block.content.result;
    if (typeof block.content.caption === 'string') return block.content.caption;
    if (typeof block.content.title === 'string') return block.content.title;
    if (typeof block.content.url === 'string') return block.content.url;
    return '';
  }

  collectOutline(blocks = [], depth = 0, items = []) {
    blocks.forEach((block) => {
      if (block?.type === 'heading_1' || block?.type === 'heading_2' || block?.type === 'heading_3') {
        const text = this.extractNotesBlockText(block);
        if (text) {
          items.push({ text, depth });
        }
      }
      if (Array.isArray(block?.children) && block.children.length > 0) {
        this.collectOutline(block.children, depth + 1, items);
      }
    });

    return items;
  }

  countBlocks(blocks = []) {
    return blocks.reduce((count, block) => {
      const childCount = Array.isArray(block?.children) ? this.countBlocks(block.children) : 0;
      return count + 1 + childCount;
    }, 0);
  }

  safeText(value) {
    if (value == null) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'Unknown';
    }
    return date.toLocaleString();
  }

  createCardLayout(strokeColor = '#D8E1F0') {
    return {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => strokeColor,
      vLineColor: () => strokeColor,
    };
  }

  buildSectionDivider(strokeColor = '#D8E1F0') {
    return {
      canvas: [{
        type: 'line',
        x1: 0,
        y1: 0,
        x2: DEFAULT_CONTENT_WIDTH,
        y2: 0,
        lineWidth: 0.75,
        lineColor: strokeColor,
      }],
      margin: [0, 0, 0, 14],
    };
  }

  getColorPalette(colorName = 'gray') {
    const palettes = {
      gray: { background: '#F3F4F6', border: '#D1D5DB', accent: '#4B5563' },
      brown: { background: '#F5ECE3', border: '#D6B89A', accent: '#8B5E3C' },
      orange: { background: '#FFF1E8', border: '#FDBA8C', accent: '#C2410C' },
      yellow: { background: '#FEF9C3', border: '#FCD34D', accent: '#A16207' },
      green: { background: '#ECFDF3', border: '#86EFAC', accent: '#15803D' },
      blue: { background: '#EFF6FF', border: '#93C5FD', accent: '#1D4ED8' },
      purple: { background: '#F5F3FF', border: '#C4B5FD', accent: '#6D28D9' },
      pink: { background: '#FDF2F8', border: '#F9A8D4', accent: '#BE185D' },
      red: { background: '#FEF2F2', border: '#FCA5A5', accent: '#B91C1C' },
    };

    return palettes[colorName] || palettes.gray;
  }

  /**
   * Build business letter
   * @param {Object} v - Variables
   * @returns {Array} PDF content
   */
  buildBusinessLetter(v) {
    const content = [];

    // Sender info
    if (v.sender_name) {
      content.push({ text: v.sender_name, margin: [0, 0, 0, 0] });
      if (v.sender_title) content.push({ text: v.sender_title, margin: [0, 0, 0, 0] });
      if (v.sender_address) content.push({ text: v.sender_address, margin: [0, 0, 0, 20] });
    }

    // Date
    content.push({ 
      text: v.date || new Date().toLocaleDateString(),
      margin: [0, 0, 0, 20]
    });

    // Recipient
    if (v.recipient_name) {
      content.push({ text: v.recipient_name, margin: [0, 0, 0, 0] });
      if (v.recipient_title) content.push({ text: v.recipient_title, margin: [0, 0, 0, 0] });
      if (v.company_name) content.push({ text: v.company_name, margin: [0, 0, 0, 20] });
    }

    // Subject
    if (v.subject) {
      content.push({
        text: [{ text: 'Subject: ', bold: true }, v.subject],
        margin: [0, 0, 0, 20]
      });
    }

    // Salutation
    content.push({
      text: v.salutation || `Dear ${v.recipient_name || 'Sir/Madam'},`,
      margin: [0, 0, 0, 20]
    });

    // Body
    if (v.body) {
      const paragraphs = v.body.split('\n\n').filter(p => p.trim());
      for (const para of paragraphs) {
        content.push({
          text: para.trim(),
          style: 'paragraph'
        });
      }
    }

    // Closing
    content.push({
      text: v.closing || 'Sincerely,',
      margin: [0, 40, 0, 40]
    });

    // Signature
    if (v.signature) content.push({ text: v.signature });
    if (v.sender_name) content.push({ text: v.sender_name });

    return content;
  }

  /**
   * Build resume
   * @param {Object} v - Variables
   * @returns {Array} PDF content
   */
  buildResume(v) {
    const content = [];

    // Name
    content.push({
      text: v.full_name || 'Name',
      style: 'title',
      alignment: 'center'
    });

    // Contact info
    const contactParts = [];
    if (v.email) contactParts.push(v.email);
    if (v.phone) contactParts.push(v.phone);
    if (v.location) contactParts.push(v.location);

    if (contactParts.length > 0) {
      content.push({
        text: contactParts.join(' | '),
        alignment: 'center',
        margin: [0, 0, 0, 20]
      });
    }

    // Separator line
    content.push({
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: DEFAULT_CONTENT_WIDTH, y2: 0, lineWidth: 2 }],
      margin: [0, 0, 0, 20]
    });

    // Summary
    if (v.summary) {
      content.push({ text: 'PROFESSIONAL SUMMARY', style: 'heading2' });
      content.push({ text: v.summary, style: 'paragraph' });
    }

    // Experience
    if (v.experience) {
      content.push({ text: 'EXPERIENCE', style: 'heading2' });
      content.push(...this.parseContent(v.experience));
    }

    // Education
    if (v.education) {
      content.push({ text: 'EDUCATION', style: 'heading2' });
      content.push(...this.parseContent(v.education));
    }

    // Skills
    if (v.skills) {
      content.push({ text: 'SKILLS', style: 'heading2' });
      content.push({ text: v.skills, style: 'paragraph' });
    }

    return content;
  }

  /**
   * Build meeting notes
   * @param {Object} v - Variables
   * @returns {Array} PDF content
   */
  buildMeetingNotes(v) {
    const content = [];

    // Title
    content.push({
      text: v.meeting_title || 'Meeting Notes',
      style: 'title'
    });

    // Details table
    const details = [];
    if (v.meeting_date) details.push(['Date:', v.meeting_date]);
    if (v.meeting_time) details.push(['Time:', v.meeting_time]);
    if (v.location) details.push(['Location:', v.location]);
    if (v.facilitator) details.push(['Facilitator:', v.facilitator]);

    if (details.length > 0) {
      content.push({
        table: {
          widths: [100, '*'],
          body: details.map(([label, value]) => [
            { text: label, bold: true },
            value
          ])
        },
        margin: [0, 0, 0, 20]
      });
    }

    // Attendees
    if (v.attendees) {
      content.push({ text: 'Attendees', style: 'heading2' });
      const attendees = v.attendees.split('\n').filter(a => a.trim());
      content.push({
        ul: attendees,
        margin: [0, 0, 0, 20]
      });
    }

    // Agenda
    if (v.agenda) {
      content.push({ text: 'Agenda', style: 'heading2' });
      content.push(...this.parseContent(v.agenda));
    }

    // Notes
    if (v.notes) {
      content.push({ text: 'Notes', style: 'heading2' });
      content.push(...this.parseContent(v.notes));
    }

    // Action Items
    if (v.action_items) {
      content.push({ text: 'Action Items', style: 'heading2' });
      const items = v.action_items.split('\n').filter(i => i.trim());
      content.push({
        ul: items.map(item => `☐ ${item.trim()}`),
        margin: [0, 0, 0, 20]
      });
    }

    return content;
  }

  /**
   * Build invoice
   * @param {Object} v - Variables
   * @returns {Array} PDF content
   */
  buildInvoice(v) {
    const content = [];
    const rawItems = Array.isArray(v.line_items)
      ? v.line_items
      : (Array.isArray(v.items) ? v.items : []);
    const lineItems = rawItems
      .map((item, index) => {
        if (Array.isArray(item)) {
          return item.slice(0, 4).map((cell) => String(cell ?? ''));
        }

        if (!item || typeof item !== 'object') {
          const description = String(item ?? '').trim();
          return description ? [description, '', '', ''] : null;
        }

        return [
          item.description || item.name || item.item || `Item ${index + 1}`,
          item.quantity ?? item.qty ?? '',
          item.unit_price ?? item.unitPrice ?? item.rate ?? item.price ?? '',
          item.amount ?? item.total ?? '',
        ].map((cell) => String(cell ?? ''));
      })
      .filter(Boolean);

    // Header
    content.push({
      columns: [
        { text: '', width: '*' },
        { 
          stack: [
            { text: 'INVOICE', style: 'title', alignment: 'right' },
            { text: `Invoice #: ${v.invoice_number || ''}`, alignment: 'right' },
            { text: `Date: ${v.invoice_date || new Date().toLocaleDateString()}`, alignment: 'right' },
            ...(v.due_date ? [{ text: `Due: ${v.due_date}`, alignment: 'right' }] : []),
          ],
          width: 'auto',
        },
      ],
      margin: [0, 0, 0, 30],
    });

    // From/To
    const columns = [];
    
    if (v.company_name) {
      columns.push({
        stack: [
          { text: 'From:', bold: true, margin: [0, 0, 0, 5] },
          { text: v.company_name },
          { text: v.company_address || '' },
        ],
        width: '*',
      });
    }

    if (v.client_name) {
      columns.push({
        stack: [
          { text: 'To:', bold: true, margin: [0, 0, 0, 5] },
          { text: v.client_name },
          { text: v.client_address || '' },
        ],
        width: '*',
      });
    }

    if (columns.length > 0) {
      content.push({ columns, margin: [0, 0, 0, 30] });
    }

    if (lineItems.length > 0) {
      content.push({
        table: {
          headerRows: 1,
          widths: ['*', 55, 85, 85],
          body: [
            [
              { text: 'Description', style: 'tableHeader' },
              { text: 'Qty', style: 'tableHeader', alignment: 'center' },
              { text: 'Unit Price', style: 'tableHeader', alignment: 'right' },
              { text: 'Amount', style: 'tableHeader', alignment: 'right' },
            ],
            ...lineItems.map((row) => [
              { text: row[0] || '' },
              { text: row[1] || '', alignment: 'center' },
              { text: row[2] || '', alignment: 'right' },
              { text: row[3] || '', alignment: 'right' },
            ]),
          ],
        },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 18],
      });
    }

    const totals = [
      ['Subtotal', v.subtotal],
      ['Tax', v.tax],
      ['Total', v.total],
      ['Amount Due', v.amount_due],
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim());

    if (totals.length > 0) {
      content.push({
        table: {
          widths: ['*', 110],
          body: totals.map(([label, value]) => {
            const isGrandTotal = label === 'Total' || label === 'Amount Due';
            return [
              { text: label, alignment: 'right', bold: isGrandTotal },
              { text: String(value), alignment: 'right', bold: isGrandTotal },
            ];
          }),
        },
        layout: 'noBorders',
        margin: [0, 0, 0, 20],
      });
    }

    if (v.notes || v.terms) {
      content.push({ text: 'Notes', style: 'heading2' });
      content.push({ text: v.notes || v.terms, margin: [0, 0, 0, 10] });
    }

    return content;
  }

  /**
   * Build generic content
   * @param {Object} v - Variables
   * @returns {Array} PDF content
   */
  buildGenericContent(v) {
    const content = [];

    for (const [key, value] of Object.entries(v)) {
      if (value && typeof value === 'string') {
        const heading = key.split('_').map(w => 
          w.charAt(0).toUpperCase() + w.slice(1)
        ).join(' ');

        content.push({ text: heading, style: 'heading2' });
        content.push(...this.parseContent(value));
      }
    }

    return content;
  }

  /**
   * Parse content string into PDF elements
   * @param {string} content - Content to parse
   * @returns {Array} PDF elements
   */
  parseContent(content) {
    if (!content) return [];

    const elements = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Bullet list
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        elements.push({
          ul: [trimmed.substring(2)],
          margin: [0, 0, 0, 5]
        });
      }
      // Numbered list
      else if (/^\d+\.\s/.test(trimmed)) {
        elements.push({
          ol: [trimmed.replace(/^\d+\.\s/, '')],
          margin: [0, 0, 0, 5]
        });
      }
      // Regular paragraph
      else {
        elements.push({
          text: trimmed,
          style: 'paragraph'
        });
      }
    }

    return elements;
  }

  /**
   * Generate document from plain text
   * @param {string} text - Plain text content
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generated document
   */
  async generateFromText(text, options = {}) {
    const docDefinition = {
      content: this.parseContent(text),
      defaultStyle: this.styles.default,
      styles: this.styles
    };

    return new Promise((resolve, reject) => {
      try {
        const PdfPrinter = require('pdfmake');
        const printer = new PdfPrinter(this.fonts);
        const doc = printer.createPdfKitDocument(docDefinition);
        
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            buffer,
            filename: options.filename || 'document.pdf',
            mimeType: 'application/pdf'
          });
        });
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = { PdfGenerator };

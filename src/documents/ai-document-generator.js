/**
 * AI Document Generator - Uses OpenAI to generate document content
 */

const {
  normalizeDocumentType,
  resolveDocumentBlueprint,
  renderBlueprintPrompt,
} = require('./document-design-blueprints');
const {
  renderDocumentLayoutPromptContext,
} = require('./document-layout-catalog');
const {
  buildDocumentQualityPlan,
  renderDocumentQualityPromptContext,
  summarizeDocumentQualityPlan,
} = require('./document-quality');

const DEFAULT_DOCUMENT_REASONING_EFFORT = 'high';

function resolveDocumentReasoningEffort(options = {}, field = 'reasoningEffort') {
  const explicit = options[field] || (field !== 'reasoningEffort' ? options.reasoningEffort : null);
  return explicit || DEFAULT_DOCUMENT_REASONING_EFFORT;
}

const TOOL_PROCESS_TEXT_PATTERNS = [
  /\b(?:web-search|web-fetch|web-scrape|document-workflow|tool call|tool step|function call)\b/i,
  /\bMissing required parameter:\s*[a-z0-9_-]+\b/i,
  /\b(?:failed|succeeded|completed)\s+with\s+(?:this\s+)?(?:exact\s+)?(?:error|tool result)\b/i,
  /\bI used the verified\b/i,
  /\bverified web-search results?\b/i,
  /\bverified research results instead\b/i,
];

const PLACEHOLDER_VISIBLE_TEXT_PATTERNS = [
  /^\s*(?:todo|tbd|placeholder|lorem ipsum)\b/i,
  /\[(?:insert|add|todo|tbd)[^\]]{0,80}\]/i,
  /\b(?:insert|add)\s+(?:specific\s+)?(?:details|content|data|chart|image|citation|source|examples?)\s+(?:here|later|below)\b/i,
  /\b(?:this|the)\s+(?:section|document|report|slide)\s+(?:should|will)\s+(?:explain|cover|describe|provide|include|outline|discuss)\b/i,
  /\b(?:overview|summary|introduction)\s+of\s+(?:the\s+)?(?:topic|key points|main points|subject matter)\b/i,
];

const INTERNAL_THOUGHT_TEXT_PATTERNS = [
  /<\s*(?:think|thinking|thought|analysis|reasoning)(?:\s[^>]*)?>[\s\S]*?<\s*\/\s*(?:think|thinking|thought|analysis|reasoning)\s*>/ig,
  /\[\s*(?:think|thinking|thought|analysis|reasoning)\s*\][\s\S]*?\[\s*\/\s*(?:think|thinking|thought|analysis|reasoning)\s*\]/ig,
  /(?:^|\n)\s*(?:begin|start)\s+(?:think|thinking|thought|analysis|reasoning)\s*\n[\s\S]*?\n\s*(?:end|stop)\s+(?:think|thinking|thought|analysis|reasoning)\s*(?=\n|$)/ig,
  /<!--\s*(?:(?:begin|start)\s+)?(?:think|thinking|thought|analysis|reasoning)\b[\s\S]*?-->/ig,
];

function sanitizeVisibleDocumentText(value = '') {
  const source = INTERNAL_THOUGHT_TEXT_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, ''),
    String(value || ''),
  );
  if (!source) {
    return '';
  }

  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }

      return ![
        ...TOOL_PROCESS_TEXT_PATTERNS,
        ...PLACEHOLDER_VISIBLE_TEXT_PATTERNS,
      ].some((pattern) => pattern.test(trimmed));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBasicHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtmlToVisibleText(value = '') {
  return decodeBasicHtmlEntities(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim());
}

const PRESENTATION_TEMPLATE_CATALOG = [
  {
    id: 'editorial-opener',
    name: 'Editorial Opener',
    bestFor: 'Thought leadership, narrative explainers, polished story arcs',
    cues: 'Bold title slide, evidence beats, spacious content slides, composed close',
    theme: 'editorial',
  },
  {
    id: 'board-update',
    name: 'Board Update',
    bestFor: 'Leadership reviews, status decks, decision readouts',
    cues: 'Executive summary slide, metrics proof, risks, recommendation, next step',
    theme: 'executive',
  },
  {
    id: 'product-reveal',
    name: 'Product Reveal',
    bestFor: 'Launches, product demos, feature storytelling',
    cues: 'Hero reveal, problem/solution contrast, feature scenes, momentum CTA',
    theme: 'product',
  },
  {
    id: 'pitch-narrative',
    name: 'Pitch Narrative',
    bestFor: 'Investor decks, startup fundraising, market storytelling',
    cues: 'Problem, solution, traction, GTM, roadmap, ask',
    theme: 'bold',
  },
  {
    id: 'visual-storyboard',
    name: 'Visual Storyboard',
    bestFor: 'Website slides, campaign concepts, cinematic decks',
    cues: 'Image-led scenes, sparse copy, bold transitions, strong visual direction',
    theme: 'product',
  },
  {
    id: 'analyst-briefing',
    name: 'Analyst Briefing',
    bestFor: 'Market analysis, research-backed strategy, comparison-heavy decks',
    cues: 'Takeaway-led titles, chart slides, comparison layouts, restrained copy',
    theme: 'executive',
  },
  {
    id: 'workshop-teaching',
    name: 'Workshop Teaching',
    bestFor: 'Training, enablement, internal education',
    cues: 'Agenda/title slide, step-by-step builds, examples, recap and actions',
    theme: 'editorial',
  },
  {
    id: 'roadmap-review',
    name: 'Roadmap Review',
    bestFor: 'Quarterly planning, product roadmap, milestone decks',
    cues: 'Now/next/later framing, milestone slides, dependencies, decisions',
    theme: 'executive',
  },
  {
    id: 'case-study',
    name: 'Case Study',
    bestFor: 'Customer stories, before/after narratives, proof decks',
    cues: 'Context, challenge, intervention, measured outcome, testimonial-style proof',
    theme: 'editorial',
  },
  {
    id: 'campaign-sprint',
    name: 'Campaign Sprint',
    bestFor: 'Marketing launches, partnerships, event decks',
    cues: 'High-contrast opener, audience tension, proof moments, CTA close',
    theme: 'bold',
  },
  {
    id: 'sales-proof',
    name: 'Sales Proof',
    bestFor: 'Prospect meetings, solution selling, objection handling',
    cues: 'Problem framing, capability proof, ROI slide, customer evidence, close',
    theme: 'executive',
  },
  {
    id: 'customer-onboarding',
    name: 'Customer Onboarding',
    bestFor: 'Enablement, rollout plans, adoption walkthroughs',
    cues: 'Outcome framing, step-by-step phases, responsibilities, recap actions',
    theme: 'editorial',
  },
  {
    id: 'ops-war-room',
    name: 'Ops War Room',
    bestFor: 'Incident reviews, operations planning, performance turnarounds',
    cues: 'Current state, pressure points, metrics, response plan, owners',
    theme: 'executive',
  },
  {
    id: 'research-lab',
    name: 'Research Lab',
    bestFor: 'Technical explainers, innovation updates, concept walkthroughs',
    cues: 'Hypothesis slide, method, findings, implications, next experiment',
    theme: 'product',
  },
  {
    id: 'partner-brief',
    name: 'Partner Brief',
    bestFor: 'Alliances, channel planning, co-marketing strategy',
    cues: 'Shared opportunity, fit, mutual value, plan, joint next steps',
    theme: 'executive',
  },
  {
    id: 'community-rally',
    name: 'Community Rally',
    bestFor: 'Internal all-hands, community updates, ambassador programs',
    cues: 'Mission opener, momentum highlights, member stories, clear call to action',
    theme: 'bold',
  },
  {
    id: 'trend-radar',
    name: 'Trend Radar',
    bestFor: 'Industry trend decks, category overviews, signal mapping',
    cues: 'Topline thesis, trend clusters, evidence snapshots, implications, response',
    theme: 'editorial',
  },
  {
    id: 'financial-briefing',
    name: 'Financial Briefing',
    bestFor: 'Budget reviews, board finance updates, planning cycles',
    cues: 'Headline numbers, variance slides, drivers, risks, recommendation',
    theme: 'executive',
  },
  {
    id: 'talent-story',
    name: 'Talent Story',
    bestFor: 'Hiring plans, org design, culture or people updates',
    cues: 'Team context, hiring gaps, role priorities, timeline, leadership ask',
    theme: 'editorial',
  },
  {
    id: 'event-run-of-show',
    name: 'Event Run of Show',
    bestFor: 'Conference planning, live event pacing, launch day coordination',
    cues: 'Timeline slide, segment breakdowns, dependencies, responsibilities, contingencies',
    theme: 'product',
  },
];

const DOCUMENT_FORMAT_CATALOG = [
  {
    id: 'briefing-memo',
    label: 'Briefing Memo',
    bestFor: 'Executive briefs, memos, board updates, one-page internal decision docs',
    shape: 'Headline summary, fast signal blocks, recommendation, risk, and next step',
    rules: [
      'Lead with the decision, takeaway, or request as early as possible.',
      'Keep section titles direct, operational, and specific to the request.',
      'Favor short paragraphs, bullets, and evidence panels over long scene-setting copy.',
    ],
  },
  {
    id: 'report-brief',
    label: 'Report / Analytical Brief',
    bestFor: 'Reports, case studies, analytical summaries, data-backed explainers, findings documents',
    shape: 'Topline takeaway, findings, evidence, interpretation, recommendation',
    rules: [
      'Show the takeaway before the supporting detail.',
      'Pair evidence with interpretation instead of listing facts without meaning.',
      'Use tables, stats, and charts only when they sharpen the analysis.',
    ],
  },
  {
    id: 'proposal-plan',
    label: 'Proposal / Plan',
    bestFor: 'Proposals, business cases, strategic plans, rollout plans, recommendations',
    shape: 'Opportunity framing, recommended approach, scope, value, timeline, explicit ask',
    rules: [
      'Make the recommendation concrete enough to approve or reject.',
      'Use section headings that sound like the actual project, not a template rubric.',
      'Surface tradeoffs, ownership, and timing without weakening the recommendation.',
    ],
  },
  {
    id: 'guide-playbook',
    label: 'Guide / Playbook',
    bestFor: 'How-to guides, manuals, onboarding docs, playbooks, SOPs, rollout instructions',
    shape: 'Orientation, steps or stages, checkpoints, examples, pitfalls, completion criteria',
    rules: [
      'Write like an operator who has done the work, not like a marketer describing it.',
      'Prefer sequences, checkpoints, examples, and warnings over abstract narrative.',
      'Break complex work into task-shaped sections with practical headings.',
    ],
  },
  {
    id: 'reference-doc',
    label: 'Reference / Documentation',
    bestFor: 'API docs, product docs, reference pages, help centers, FAQs, technical references',
    shape: 'Overview, prerequisites, definitions, examples, reference tables, troubleshooting or FAQ',
    rules: [
      'Optimize for lookup speed and wayfinding, not story pacing.',
      'Use definitions, examples, and compact reference blocks where they help scanning.',
      'Keep headings literal and discoverable for someone searching for an answer.',
    ],
  },
  {
    id: 'editorial-feature',
    label: 'Editorial Feature',
    bestFor: 'Articles, thought pieces, narrative explainers, magazine-style stories, feature docs',
    shape: 'Strong opening thesis, paced story beats, proof moments, reflective close',
    rules: [
      'Let the section titles sound authored and human rather than procedural.',
      'Use narrative rhythm and contrast between heavier and lighter sections.',
      'Do not turn an article into a memo broken into chunks.',
    ],
  },
  {
    id: 'newsletter-digest',
    label: 'Newsletter / Digest',
    bestFor: 'Roundups, recurring updates, digests, editorial newsletters, curation docs',
    shape: 'Lead note, curated sections, highlights, quick reads, closing CTA or watchlist',
    rules: [
      'Use modular sections with crisp summaries and scannable highlights.',
      'Keep the voice current and specific instead of sounding evergreen or generic.',
      'Let recurring sections feel intentional, not like placeholder blocks.',
    ],
  },
  {
    id: 'formal-letter',
    label: 'Formal Letter',
    bestFor: 'Business letters, cover letters, formal correspondence, outreach with a clear purpose',
    shape: 'Purpose, supporting detail, clear request or statement, professional close',
    rules: [
      'Keep the tone human and specific rather than stiff boilerplate.',
      'Do not over-structure the body into report-like sections unless the request demands it.',
      'Make the purpose obvious in the opening paragraph.',
    ],
  },
];

const BLUEPRINT_DOCUMENT_FORMAT_MAP = {
  document: 'editorial-feature',
  report: 'report-brief',
  proposal: 'proposal-plan',
  memo: 'briefing-memo',
  letter: 'formal-letter',
  'executive-brief': 'briefing-memo',
  'data-story': 'report-brief',
};

function findDocumentFormat(id = '') {
  const normalized = String(id || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return DOCUMENT_FORMAT_CATALOG.find((entry) => entry.id === normalized) || null;
}

function selectDocumentFormat({
  prompt = '',
  documentType = 'document',
  format = 'html',
  designPlan = null,
} = {}) {
  const explicitFormatId = String(
    designPlan?.documentFormatId
    || designPlan?.selectedDocumentFormat?.id
    || '',
  ).trim().toLowerCase();
  if (explicitFormatId) {
    return findDocumentFormat(explicitFormatId) || findDocumentFormat(BLUEPRINT_DOCUMENT_FORMAT_MAP.document);
  }

  const normalizedPrompt = String(prompt || '').trim().toLowerCase();
  const normalizedFormat = String(format || '').trim().toLowerCase();
  const normalizedDocumentType = normalizeDocumentType(documentType || 'document');

  if (/\b(api|reference|troubleshooting|faq|knowledge base|help center|docs?|documentation)\b/.test(normalizedPrompt)) {
    return findDocumentFormat('reference-doc');
  }

  if (/\b(playbook|runbook|manual|guide|onboarding|checklist|how to|how-to|workflow|sop|standard operating procedure)\b/.test(normalizedPrompt)) {
    return findDocumentFormat('guide-playbook');
  }

  if (/\b(newsletter|digest|roundup|weekly note|monthly note|briefing email)\b/.test(normalizedPrompt)) {
    return findDocumentFormat('newsletter-digest');
  }

  if (/\b(letter|cover letter|outreach|correspondence)\b/.test(normalizedPrompt) || normalizedDocumentType === 'letter') {
    return findDocumentFormat('formal-letter');
  }

  if (/\b(proposal|business case|plan|roadmap|rollout|recommendation|strategy)\b/.test(normalizedPrompt) || normalizedDocumentType === 'proposal') {
    return findDocumentFormat('proposal-plan');
  }

  if (/\b(report|analysis|findings|case study|insight|insights|data story|postmortem|review)\b/.test(normalizedPrompt)
    || normalizedDocumentType === 'report'
    || normalizedDocumentType === 'data-story') {
    return findDocumentFormat('report-brief');
  }

  if (/\b(memo|brief|board update|executive update|decision)\b/.test(normalizedPrompt)
    || normalizedDocumentType === 'memo'
    || normalizedDocumentType === 'executive-brief') {
    return findDocumentFormat('briefing-memo');
  }

  if (/\b(article|blog|essay|story|feature|editorial|magazine|narrative)\b/.test(normalizedPrompt)
    || normalizedFormat === 'html') {
    return findDocumentFormat('editorial-feature');
  }

  return findDocumentFormat(BLUEPRINT_DOCUMENT_FORMAT_MAP[normalizedDocumentType] || 'editorial-feature');
}

function renderDocumentFormatPromptContext(formatProfile = null, options = {}) {
  if (!formatProfile) {
    return '';
  }

  const normalizedFormat = String(options.format || '').trim().toLowerCase();
  const lines = [
    '<document_formats>',
    'Choose the document format that best fits the request. Do not default to a generic numbered brief or a recycled template scaffold.',
    normalizedFormat === 'html' || normalizedFormat === 'pdf'
      ? 'For HTML and PDF outputs, this format choice should change the information architecture and writing pattern, not just the visual shell.'
      : 'Use the selected format to shape the document architecture and pacing.',
    ...DOCUMENT_FORMAT_CATALOG.map((entry) => (
      `- ${entry.label} [${entry.id}] :: best for ${entry.bestFor} :: shape ${entry.shape}`
    )),
    `Selected document format: ${formatProfile.label} [${formatProfile.id}]`,
    'Format rules:',
    ...formatProfile.rules.map((entry) => `- ${entry}`),
    '- Use concrete, request-specific section headings instead of copying blueprint labels or generic template wording.',
    '- Never mention template ids, internal format names, layout labels, or planning notes in visible copy.',
    '</document_formats>',
  ];

  return lines.join('\n');
}

function normalizePageTarget(value = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Math.min(Math.floor(numeric), 20);
}

function extractDocumentResponsePartText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const candidates = [
    value.text,
    value.output_text,
    value.outputText,
    value.refusal,
    value.value,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) {
      return candidate;
    }
  }

  return '';
}

class AIDocumentGenerator {
  constructor(openaiClient) {
    this.openai = openaiClient;
  }

  extractText(response) {
    const directText = extractDocumentResponsePartText({
      output_text: response?.output_text,
      outputText: response?.outputText,
    }).trim();
    if (directText) {
      return directText;
    }

    if (Array.isArray(response?.output)) {
      return response.output
        .filter((item) => item?.type === 'message')
        .map((item) => (Array.isArray(item.content) ? item.content : [])
          .map((content) => extractDocumentResponsePartText(content))
          .join(''))
        .join('\n')
        .trim();
    }

    const choiceContent = response?.choices?.[0]?.message?.content;
    if (Array.isArray(choiceContent)) {
      return choiceContent.map((content) => extractDocumentResponsePartText(content)).join('').trim();
    }

    return String(choiceContent || '').trim();
  }

  async requestResponse({ messages, model, reasoningEffort = null, stream = false }) {
    if (typeof this.openai?.createResponse === 'function') {
      return this.openai.createResponse({
        input: messages,
        stream,
        model: model || null,
        reasoningEffort: reasoningEffort || null,
      });
    }

    if (typeof this.openai?.chat?.completions?.create === 'function') {
      return this.openai.chat.completions.create({
        model: model || 'gpt-4o',
        messages,
        stream,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      });
    }

    if (typeof this.openai?.responses?.create === 'function') {
      return this.openai.responses.create({
        model: model || 'gpt-4o',
        input: messages,
        stream,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      });
    }

    throw new Error('No compatible response client is configured');
  }

  async requestJson({ messages, model, reasoningEffort = null }) {
    const response = await this.requestResponse({ messages, model, reasoningEffort, stream: false });
    const text = this.extractText(response);
    return this.parseJsonResponseText(text);
  }

  async requestText({ messages, model, reasoningEffort = null }) {
    const response = await this.requestResponse({ messages, model, reasoningEffort, stream: false });
    return this.extractText(response);
  }

  /**
   * Generate document content using AI
   * @param {string} prompt - User prompt
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generated content structure
   */
  async generate(prompt, options = {}) {
    const antiScaffoldPass = Boolean(options._antiScaffoldPass);
    const systemPrompt = this.buildSystemPrompt({
      ...options,
      prompt,
      antiScaffold: antiScaffoldPass,
    });
    
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ];

    try {
      const content = await this.requestJson({
        messages,
        model: options.model || 'gpt-4o',
        reasoningEffort: resolveDocumentReasoningEffort(options),
      });
      const normalizedContent = this.normalizeDocumentStructure(content);

      if (this.isLikelyScaffoldedDocument(normalizedContent) && !antiScaffoldPass && options.retryOnScaffold !== false) {
        return this.generate(prompt, {
          ...options,
          _antiScaffoldPass: true,
        });
      }

      return this.applyDocumentQualityPass(prompt, normalizedContent, {
        ...options,
        documentType: options.documentType || 'document',
      });
    } catch (error) {
      if (error?.responseText) {
        console.warn('[AIDocumentGenerator] Recovering from non-JSON AI response:', error.message);
        const fallbackContent = this.normalizeDocumentStructure(
          this.buildFallbackDocumentFromText(error.responseText, prompt, options),
        );
        return this.applyDocumentQualityPass(prompt, fallbackContent, {
          ...options,
          documentType: options.documentType || 'document',
        });
      }
      console.error('[AIDocumentGenerator] Generation failed:', error);
      throw new Error(`AI generation failed: ${error.message}`);
    }
  }

  isLikelyScaffoldedDocument(content = {}) {
    const sections = Array.isArray(content?.sections) ? content.sections : [];
    const normalizedSections = sections.filter((section) => section && typeof section === 'object');
    if (normalizedSections.length <= 1) {
      return true;
    }

    const hasRichContent = normalizedSections.some((section) => {
      const sectionText = String(section.content || '').trim();
      const bullets = Array.isArray(section.bullets) ? section.bullets.filter(Boolean) : [];
      const hasStructured = Array.isArray(section.stats) && section.stats.length > 0
        || section.callout
        || section.table
        || section.chart;
      return sectionText.length > 180 || bullets.join(' ').length > 180 || hasStructured;
    });

    if (hasRichContent) {
      return false;
    }

    if (normalizedSections.length > 8) {
      return false;
    }

    const scaffoldHeading = /^(step|section|slide|point|item)\s*\d+$/i;
    const isHeadingScaffolded = normalizedSections.every((section) => {
      const heading = String(section.heading || '').trim();
      return heading.length < 32 && (scaffoldHeading.test(heading) || /^part\s*\d+$/i.test(heading));
    });

    return isHeadingScaffolded;
  }

  shouldRunQualityPass(options = {}) {
    return options.qualityPass !== false && options.disableQualityPass !== true;
  }

  buildDocumentQualityRevisionPrompt(prompt = '', content = {}, options = {}) {
    const qualityPlan = buildDocumentQualityPlan({
      documentType: options.documentType || 'document',
      format: options.format || 'html',
      designPlan: options.designPlan || null,
    });

    return [
      renderDocumentQualityPromptContext(qualityPlan),
      '<source_request>',
      String(prompt || '').trim(),
      '</source_request>',
      options.templateContext ? '<template_context>' : null,
      options.templateContext || null,
      options.templateContext ? '</template_context>' : null,
      this.renderDesignPlanPrompt(options.designPlan),
      '<current_document_json>',
      JSON.stringify(content, null, 2),
      '</current_document_json>',
      '<revision_instructions>',
      '- Return only the revised JSON object using the same document schema.',
      '- Preserve accurate facts, numbers, citations, URLs, names, and constraints from the current draft and source request.',
      '- Improve document architecture, heading specificity, background/design readiness, evidence interpretation, and final prose polish.',
      '- Prefer small precise improvements over rewriting good content into generic prose.',
      '- Keep title, subtitle, theme, sections, and metadata valid for the renderer.',
      '- Add metadata.qualityStandard and metadata.qualityNotes summarizing the revision, but do not expose internal pass names in visible copy.',
      '- Preserve or add metadata.userGoal, assumptions, openQuestions, acceptanceChecks, and verificationNotes so the final artifact is aligned with the user request and target medium.',
      '- Do not output markdown fences, commentary, or any text outside the JSON object.',
      '</revision_instructions>',
    ].filter(Boolean).join('\n');
  }

  async applyDocumentQualityPass(prompt = '', content = {}, options = {}) {
    const qualityPlan = buildDocumentQualityPlan({
      documentType: options.documentType || 'document',
      format: options.format || 'html',
      designPlan: options.designPlan || null,
    });
    const qualitySummary = summarizeDocumentQualityPlan(qualityPlan);

    if (!this.shouldRunQualityPass(options)) {
      return {
        ...content,
        metadata: {
          ...(content.metadata || {}),
          qualityStandard: qualitySummary,
          qualityPassApplied: false,
          qualityPassSkipped: true,
        },
      };
    }

    try {
      const revised = await this.requestJson({
        messages: [
          {
            role: 'system',
            content: 'You are a document quality council. Run the specialist review passes silently, then return only corrected JSON.',
          },
          {
            role: 'user',
            content: this.buildDocumentQualityRevisionPrompt(prompt, content, options),
          },
        ],
        model: options.qualityModel || options.model || 'gpt-4o',
        reasoningEffort: resolveDocumentReasoningEffort(options, 'qualityReasoningEffort'),
      });
      const normalized = this.normalizeDocumentStructure(revised);

      return {
        ...normalized,
        metadata: {
          ...(normalized.metadata || {}),
          qualityStandard: normalized.metadata?.qualityStandard || qualitySummary,
          qualityPassApplied: true,
        },
      };
    } catch (error) {
      console.warn('[AIDocumentGenerator] Quality pass failed:', error.message);
      return {
        ...content,
        metadata: {
          ...(content.metadata || {}),
          qualityStandard: qualitySummary,
          qualityPassApplied: false,
          qualityPassError: String(error.message || 'Quality pass failed').slice(0, 180),
        },
      };
    }
  }

  /**
   * Expand an outline into full document content
   * @param {Array} outline - Document outline
   * @param {Object} options - Expansion options
   * @returns {Promise<Array>} Expanded outline
   */
  async expandOutline(outline, options = {}) {
    const expanded = [];

    for (const item of outline) {
      const expandedItem = await this.expandOutlineItem(item, options);
      expanded.push(expandedItem);
    }

    return expanded;
  }

  /**
   * Expand a single outline item
   * @param {Object} item - Outline item
   * @param {Object} options - Expansion options
   * @returns {Promise<Object>} Expanded item
   */
  async expandOutlineItem(item, options) {
    const prompt = `Expand the following section into detailed content:

Title: ${item.title || item.heading}
Level: ${item.level || 1}
Notes: ${item.notes || 'None'}

Requirements:
- Length: ${options.length || 'medium'} (short: 100-200 words, medium: 300-500 words, long: 600-1000 words)
- Tone: ${options.tone || 'professional'}
- Write comprehensive, well-structured content
- Include specific details and examples where appropriate
- Use professional formatting with paragraphs and lists as needed

Output JSON:
{
  "content": "The expanded content...",
  "keyPoints": ["point 1", "point 2"]
}`;

    try {
      const result = await this.requestJson({
        messages: [{ role: 'user', content: prompt }],
        model: options.model || 'gpt-4o',
        reasoningEffort: resolveDocumentReasoningEffort(options),
      });

      return {
        ...item,
        content: result.content,
        keyPoints: result.keyPoints || [],
        subsections: item.children ? 
          await this.expandOutline(item.children, options) : []
      };
    } catch (error) {
      console.error('[AIDocumentGenerator] Outline expansion failed:', error);
      return {
        ...item,
        content: `Error expanding section: ${item.title}`,
        error: error.message
      };
    }
  }

  /**
   * Generate a document from structured data
   * @param {Object} data - Structured data
   * @param {string} documentType - Type of document
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generated content
   */
  async generateFromData(data, documentType, options = {}) {
    const prompt = `Generate a ${documentType} from the following data:

${JSON.stringify(data, null, 2)}

Create a professional document that presents this data effectively.`;

    return this.generate(prompt, { ...options, documentType });
  }

  /**
   * Improve existing content
   * @param {string} content - Content to improve
   * @param {string} improvement - Type of improvement
   * @param {Object} options - Options
   * @returns {Promise<string>} Improved content
   */
  async improveContent(content, improvement = 'general', options = {}) {
    const improvementPrompts = {
      'general': 'Improve the following text to make it more professional and engaging',
      'grammar': 'Fix any grammar and spelling errors in the following text',
      'clarity': 'Rewrite the following text for better clarity and conciseness',
      'professional': 'Rewrite in a more professional, business-appropriate tone',
      'casual': 'Rewrite in a more casual, conversational tone',
      'technical': 'Rewrite using more technical terminology and precision',
      'simplify': 'Simplify the following text for a general audience',
      'expand': 'Expand the following text with more detail and examples',
      'shorten': 'Make the following text more concise while keeping key points'
    };

    const instruction = improvementPrompts[improvement] || improvementPrompts.general;

    const prompt = `${instruction}:

${content}

Return only the improved text, no explanations.`;

    try {
      return await this.requestText({
        messages: [{ role: 'user', content: prompt }],
        model: options.model || 'gpt-4o',
        reasoningEffort: resolveDocumentReasoningEffort(options),
      });
    } catch (error) {
      console.error('[AIDocumentGenerator] Improvement failed:', error);
      return content; // Return original on failure
    }
  }

  /**
   * Generate document metadata
   * @param {string} content - Document content
   * @returns {Promise<Object>} Metadata
   */
  async generateMetadata(content) {
    const prompt = `Analyze the following document and generate metadata:

${content.substring(0, 2000)}...

Return JSON:
{
  "title": "Suggested document title",
  "summary": "Brief summary of content",
  "keywords": ["keyword1", "keyword2"],
  "category": "business|technical|creative|academic",
  "wordCount": 1234,
  "estimatedPages": 5,
  "suggestedTags": ["tag1", "tag2"]
}`;

    try {
      return await this.requestJson({
        messages: [{ role: 'user', content: prompt }],
        model: 'gpt-4o-mini',
      });
    } catch (error) {
      console.error('[AIDocumentGenerator] Metadata generation failed:', error);
      return {
        title: 'Untitled Document',
        summary: '',
        keywords: [],
        category: 'general'
      };
    }
  }

  /**
   * Build system prompt for document generation
   * @param {Object} options - Generation options
   * @returns {string} System prompt
   */
  buildSystemPrompt(options = {}) {
    const normalizedDocumentType = normalizeDocumentType(options.documentType || 'document');
    const documentType = normalizedDocumentType || 'document';
    const tone = options.tone || 'professional';
    const length = options.length || 'medium';
    const language = options.language || 'en';
    const pageTarget = normalizePageTarget(options.pageTarget || options.maxPages || options.pages);
    const blueprint = resolveDocumentBlueprint(documentType);
    const formatProfile = selectDocumentFormat({
      prompt: options.prompt || '',
      documentType,
      format: options.format || '',
      designPlan: options.designPlan,
    });
    const qualityPlan = buildDocumentQualityPlan({
      documentType,
      format: options.format || 'html',
      designPlan: options.designPlan || null,
    });
    const planPrompt = this.renderDesignPlanPrompt(options.designPlan);

    const lengthGuidance = {
      short: 'Keep content concise (100-200 words per section)',
      medium: 'Provide moderate detail (300-500 words per section)',
      long: 'Be comprehensive (600-1000 words per section)',
      detailed: 'Provide extensive detail with examples (1000+ words per section)'
    };

    const toneGuidance = {
      professional: 'Use formal, business-appropriate language',
      casual: 'Use conversational, friendly language',
      technical: 'Use precise technical terminology and structured explanations',
      academic: 'Use scholarly language with proper citations and formal structure',
      persuasive: 'Use compelling language to convince the reader',
      informative: 'Focus on clear, factual presentation of information'
    };

    return [
      `<role>You are an expert document writer specializing in ${blueprint.label} outputs.</role>`,
      '<writing_style>',
      `- Tone: ${toneGuidance[tone] || toneGuidance.professional}`,
      `- Length: ${lengthGuidance[length] || lengthGuidance.medium}`,
      pageTarget ? `- Target depth: up to ${pageTarget} pages. Expand coverage only when the source material supports it, and keep every page aligned to the researched facts.` : null,
      language !== 'en' ? `- Language: Write in ${language}` : null,
      '</writing_style>',
      options.templateContext || null,
      renderBlueprintPrompt(blueprint),
      renderDocumentFormatPromptContext(formatProfile, {
        format: options.format || '',
      }),
      renderDocumentLayoutPromptContext(options.designPlan, options.format),
      renderDocumentQualityPromptContext(qualityPlan),
      planPrompt,
      '<visual_safety>',
      '- Treat the page background, content surface, panels, dark bands, table headers, chart areas, captions, and muted text as explicit color-paired surfaces.',
      '- Choose theme, callout, table, chart, and image treatments that keep text readable against their backgrounds.',
      '- Avoid white or near-white text unless the surface behind it is explicitly dark.',
      '- Avoid dark text on dark panels; normal body text should have strong contrast and muted text must still be readable.',
      '- For HTML, PDF, and presentation-oriented outputs, assume the renderer will be visually checked on desktop and mobile and keep layouts free of overlapping or clipped text.',
      '- For PDF outputs, choose the intended page geometry before writing CSS, declare it with @page size and margin, and compose the layout to that page rather than relying on export-time scaling.',
      '- For PDF outputs, constrain all shells, grids, tables, images, figures, and pre/code blocks to the printable content box. Avoid fixed widths that exceed the page after margins; use max-width:100%, table-layout:fixed, and wrapping for long tokens or code.',
      '- For PDF outputs, use clean section rhythm: one divider, spacing, or a heading band between major sections. Do not put every section in a full bordered card, because those borders often look bad across page breaks.',
      '</visual_safety>',
      '<output_contract>',
      'Return a JSON object with this exact structure:',
      '{',
      '  "title": "Document Title",',
      '  "subtitle": "Optional subtitle",',
      '  "theme": "editorial|executive|product|bold",',
      '  "sections": [',
      '    {',
      '      "heading": "Section Heading",',
      '      "content": "Section content with proper paragraphs...",',
      '      "level": 1,',
      '      "bullets": ["Optional concise bullet", "Optional concise bullet"],',
      '      "callout": {',
      '        "title": "Optional callout heading",',
      '        "body": "Optional high-signal note or warning",',
      '        "tone": "note|highlight|warning"',
      '      },',
      '      "stats": [',
      '        { "label": "Metric", "value": "Value", "detail": "Optional context" }',
      '      ],',
      '      "table": {',
      '        "caption": "Optional table caption",',
      '        "headers": ["Column A", "Column B"],',
      '        "rows": [["Value 1", "Value 2"]]',
      '      },',
      '      "chart": {',
      '        "title": "Optional chart title",',
      '        "type": "bar|line|comparison",',
      '        "summary": "Optional chart takeaway",',
      '        "series": [',
      '          { "label": "Series label", "value": 42 }',
      '        ]',
      '      },',
      '      "imageUrl": "Optional direct image URL from verified image references",',
      '      "imageAlt": "Optional alt text for the image",',
      '      "imageCaption": "Optional concise caption for the image"',
      '    }',
      '  ],',
      '  "metadata": {',
      '    "wordCount": 1234,',
      '    "estimatedPages": 5,',
      '    "keywords": ["keyword1", "keyword2"],',
      `    "qualityStandard": "${qualityPlan.version}",`,
      '    "userGoal": "Compact statement of the user job this document satisfies",',
      '    "purposeLock": "One sentence naming the subject, audience, and outcome this document is built to support",',
      '    "assumptions": ["Safe assumption used instead of blocking for more input"],',
      '    "openQuestions": [],',
      '    "acceptanceChecks": ["Medium-specific checks the final artifact should satisfy"],',
      '    "verificationNotes": ["Checks already run or still required for the target medium"]',
      '  }',
      '}',
      '</output_contract>',
      '<rules>',
      '- Write the actual content, not placeholders.',
      '- Build to the subject and user situation, not to a template slot. Every section should earn its place through the specific topic, audience, and purpose.',
      '- Create comprehensive, well-structured content with concrete detail.',
      '- Use paragraphs for explanation and structured fields for scan speed.',
      '- When a section benefits from metrics, tables, or a chart, populate the matching structured field instead of burying everything in prose.',
      '- When verified image references are provided and the section benefits from a visual, use imageUrl/imageAlt/imageCaption fields rather than describing missing images in prose.',
      '- Only include bullets, stats, tables, charts, or callouts when they strengthen the document.',
      '- Convert abstract coverage beats into natural, request-specific headings and prose.',
      '- Do not let the output read like a template, rubric, or plan for a future document.',
      '- If a planned section lacks enough real context, either omit it, state a bounded assumption/limit in metadata, or put the blocker in metadata.openQuestions rather than filling it with generic prose.',
      '- Populate metadata.userGoal, purposeLock, assumptions, openQuestions, acceptanceChecks, and verificationNotes so the artifact carries the creation decisions and final-fit criteria forward.',
      '- Keep openQuestions empty unless the missing answer would materially change the document; do not use metadata as visible process chatter.',
      pageTarget ? `- Keep metadata.estimatedPages at or below ${pageTarget}.` : null,
      '- Never mention internal tool names, failed tool calls, exact tool errors, web-search/web-fetch workflow steps, or process notes in visible document text.',
      '- Do not output markdown fences, commentary, or any text outside the JSON object.',
      options.antiScaffold
        ? '- If a previous draft drifted into a numbered scaffold (for example "Step 1", "Section 2"), do not output it again. Expand each section into request-specific headings and substance tied to the prompt.'
        : null,
      '</rules>',
    ].filter(Boolean).join('\n');
  }

  renderDesignPlanPrompt(designPlan = null) {
    if (!designPlan || typeof designPlan !== 'object') {
      return '';
    }

    const outline = Array.isArray(designPlan.outline) ? designPlan.outline : [];
    const lines = [
      '<production_plan>',
      designPlan.titleSuggestion ? `Title suggestion: ${designPlan.titleSuggestion}` : null,
      designPlan.outlineType ? `Outline type: ${designPlan.outlineType}` : null,
      designPlan.themeSuggestion ? `Theme suggestion: ${designPlan.themeSuggestion}` : null,
      designPlan.creativeDirection?.label ? `Creative direction: ${designPlan.creativeDirection.label}` : null,
      designPlan.creativeDirection?.rationale ? `Creative rationale: ${designPlan.creativeDirection.rationale}` : null,
      Array.isArray(designPlan.humanizationNotes) && designPlan.humanizationNotes.length > 0 ? 'Humanization notes:' : null,
      ...(Array.isArray(designPlan.humanizationNotes)
        ? designPlan.humanizationNotes.map((entry) => `- ${entry}`)
        : []),
      Array.isArray(designPlan.sampleHandling) && designPlan.sampleHandling.length > 0 ? 'Sample handling:' : null,
      ...(Array.isArray(designPlan.sampleHandling)
        ? designPlan.sampleHandling.map((entry) => `- ${entry}`)
        : []),
      outline.length > 0 ? 'Coverage beats to address (adapt these into natural, request-specific headings rather than copying the labels verbatim):' : null,
      ...outline.map((item) => {
        const label = item.title || item.heading || `Section ${item.index || ''}`.trim();
        const detail = [
          item.purpose,
          item.layout,
          item.suggestedBlocks ? `blocks=${item.suggestedBlocks.join(',')}` : '',
        ].filter(Boolean).join(' :: ');
        return `- ${label}${detail ? ` :: ${detail}` : ''}`;
      }),
      '</production_plan>',
    ];

    return lines.filter(Boolean).join('\n');
  }

  parseJsonResponseText(text = '') {
    const rawText = String(text || '').trim();
    const candidates = [
      rawText,
      this.unwrapCodeFence(rawText),
      this.extractFirstJsonBlock(rawText),
    ].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch (_error) {
        // Try the next candidate.
      }
    }

    const error = new SyntaxError(
      `Unexpected token in AI response: ${rawText.slice(0, 80) || '[empty response]'}`,
    );
    error.responseText = rawText;
    throw error;
  }

  unwrapCodeFence(text = '') {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : trimmed;
  }

  extractFirstJsonBlock(text = '') {
    const source = this.unwrapCodeFence(text);
    const objectStart = source.indexOf('{');
    const arrayStart = source.indexOf('[');
    const hasObject = objectStart !== -1;
    const hasArray = arrayStart !== -1;

    if (!hasObject && !hasArray) {
      return '';
    }

    const start = hasObject && hasArray
      ? Math.min(objectStart, arrayStart)
      : (hasObject ? objectStart : arrayStart);
    const openChar = source[start];
    const closeChar = openChar === '{' ? '}' : ']';

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === openChar) {
        depth += 1;
      } else if (char === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }

    return '';
  }

  buildFallbackDocumentFromText(text = '', prompt = '', options = {}) {
    const rawText = String(text || '').trim();
    const theme = options.designPlan?.themeSuggestion || options.theme || options.style || 'editorial';
    const rawHtmlDocument = /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(rawText);
    const htmlTitle = rawHtmlDocument
      ? stripHtmlToVisibleText(rawText.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
      : '';
    const htmlHeading = rawHtmlDocument
      ? stripHtmlToVisibleText(rawText.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
      : '';
    const htmlBodySource = rawHtmlDocument
      ? (
        rawText.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
        || rawText.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
        || rawText
      )
      : '';
    const recoveredText = rawHtmlDocument
      ? stripHtmlToVisibleText(htmlBodySource)
      : rawText;
    const title = options.designPlan?.titleSuggestion
      || htmlTitle
      || htmlHeading
      || this.deriveTitleFromPrompt(prompt)
      || 'Generated Document';
    const heading = options.designPlan?.outline?.[0]?.heading || htmlHeading || 'Overview';

    return {
      title,
      subtitle: '',
      theme,
      sections: [
        {
          heading,
          content: recoveredText || rawText,
          level: 1,
        },
      ],
      metadata: {
        parseRecovery: rawHtmlDocument ? 'html-fallback' : 'plain-text-fallback',
      },
    };
  }

  deriveTitleFromPrompt(prompt = '') {
    const normalized = String(prompt || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) {
      return '';
    }

    return normalized
      .replace(/^(create|make|generate|build|produce|draft|prepare)\s+/i, '')
      .replace(/[.?!].*$/, '')
      .trim()
      .slice(0, 80);
  }

  renderPresentationTemplateGuidance(designPlan = null) {
    const lines = [
      '<template_gallery>',
      'Use these deck archetypes as examples and building blocks, not hard rules.',
      'You may adapt, combine, or ignore them when the request calls for a better structure.',
      ...PRESENTATION_TEMPLATE_CATALOG.map((template) => (
        `- ${template.name} [${template.id}] :: best for ${template.bestFor} :: cues ${template.cues} :: default render theme ${template.theme}`
      )),
    ];

    const recommendedTemplates = Array.isArray(designPlan?.recommendedTemplates)
      ? designPlan.recommendedTemplates
      : [];

    if (recommendedTemplates.length > 0) {
      lines.push('Request-specific built-in templates to consider:');
      recommendedTemplates.forEach((template) => {
        const details = [
          template.description,
          Array.isArray(template.useCases) && template.useCases.length > 0
            ? `use cases=${template.useCases.join(', ')}`
            : '',
        ].filter(Boolean).join(' :: ');
        lines.push(`- ${template.name || template.id}${details ? ` :: ${details}` : ''}`);
      });
    }

    lines.push('</template_gallery>');
    return lines.join('\n');
  }

  /**
   * Normalize document structure
   * @param {Object} content - Raw AI response
   * @returns {Object} Normalized structure
   */
  normalizeDocumentStructure(content) {
    // Ensure required fields exist
    const normalized = {
      title: sanitizeVisibleDocumentText(content.title || 'Untitled Document') || 'Untitled Document',
      subtitle: sanitizeVisibleDocumentText(content.subtitle || ''),
      theme: content.theme || 'editorial',
      sections: [],
      metadata: {
        wordCount: 0,
        estimatedPages: 0,
        keywords: [],
        ...content.metadata
      }
    };

    // Normalize sections
    if (Array.isArray(content.sections)) {
      normalized.sections = content.sections.map((section, index) => this.normalizeDocumentSection(section, index));
    } else if (content.content) {
      // Single content block
      normalized.sections = [{
        heading: 'Content',
        content: content.content,
        level: 1,
        bullets: [],
        stats: [],
      }];
    }

    // Calculate word count if not provided
    if (!normalized.metadata.wordCount) {
      normalized.metadata.wordCount = normalized.sections.reduce(
        (count, section) => count + (section.content?.split(/\s+/).length || 0),
        0
      );
    }

    // Estimate pages
    if (!normalized.metadata.estimatedPages) {
      normalized.metadata.estimatedPages = Math.ceil(normalized.metadata.wordCount / 250);
    }

    return normalized;
  }

  normalizeDocumentSection(section = {}, index = 0) {
    const normalizedTable = this.normalizeTable(section.table);
    const normalizedChart = this.normalizeChart(section.chart);
    const normalizedStats = this.normalizeStats(section.stats || section.metrics || section.highlights)
      .map((stat) => ({
        ...stat,
        label: sanitizeVisibleDocumentText(stat.label),
        value: sanitizeVisibleDocumentText(stat.value),
        detail: sanitizeVisibleDocumentText(stat.detail),
      }))
      .filter((stat) => stat.label || stat.value || stat.detail);

    return {
      heading: sanitizeVisibleDocumentText(section.heading || section.title || `Section ${index + 1}`) || `Section ${index + 1}`,
      content: typeof section.content === 'string'
        ? sanitizeVisibleDocumentText(section.content)
        : Array.isArray(section.content)
          ? sanitizeVisibleDocumentText(section.content.filter(Boolean).join('\n'))
          : '',
      level: Number(section.level) || 1,
      bullets: this.normalizeStringList(section.bullets || section.points || section.keyPoints)
        .map((entry) => sanitizeVisibleDocumentText(entry))
        .filter(Boolean),
      callout: this.normalizeCallout(section.callout || section.highlight || section.note),
      stats: normalizedStats,
      table: normalizedTable,
      chart: normalizedChart,
      imageUrl: section.imageUrl || section.image_url || '',
      imageAlt: section.imageAlt || section.image_alt || '',
      imageCaption: sanitizeVisibleDocumentText(section.imageCaption || section.image_caption || section.caption || ''),
    };
  }

  /**
   * Generate presentation content from a topic or outline
   * @param {string} topic - Presentation topic
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Presentation content structure
   */
  async generatePresentationContent(topic, options = {}) {
    const slideCount = options.slideCount || 6;
    const tone = options.tone || 'professional';
    const audience = options.audience || 'general audience';
    const theme = options.theme || options.style || 'editorial';
    const includeImages = options.includeImages !== false;
    const includeCharts = options.includeCharts !== false;
    const pageTarget = normalizePageTarget(options.pageTarget || options.maxPages || options.pages);
    const blueprint = resolveDocumentBlueprint(options.documentType || 'presentation');
    const designPlan = options.designPlan || null;
    const qualityPlan = buildDocumentQualityPlan({
      documentType: options.documentType || 'presentation',
      format: options.format || 'pptx',
      designPlan,
    });

    const prompt = [
      `<task>Create a ${blueprint.label} about: ${topic}</task>`,
      '<requirements>',
      `- Create exactly ${slideCount} slides.`,
      `- Tone: ${tone}.`,
      `- Audience: ${audience}.`,
      `- Theme/style: ${theme}.`,
      pageTarget ? `- Target depth: up to ${pageTarget} pages/slides of research-aligned material; do not pad beyond the useful story.` : null,
      '- Include a compelling title slide.',
      '- Maintain visible narrative progression from slide to slide.',
      '- Keep each slide focused on one dominant idea.',
      '- Use 3-5 concise bullets only when bullets improve scanning.',
      includeImages ? '- For visual or high-emotion slides, add a strong imagePrompt.' : null,
      includeCharts ? '- Use chart slides when comparison or trend data helps the story, and provide explicit chart series values.' : null,
      '</requirements>',
      this.renderPresentationTemplateGuidance(designPlan),
      options.templateContext || null,
      renderBlueprintPrompt(blueprint),
      renderDocumentQualityPromptContext(qualityPlan),
      this.renderDesignPlanPrompt(designPlan),
      '<output_contract>',
      'Return JSON with this structure:',
      '{',
      '  "title": "Presentation Title",',
      '  "subtitle": "Subtitle or tagline",',
      '  "theme": "editorial|executive|product|bold",',
      '  "metadata": {',
      '    "qualityStandard": "document-quality-standard-version",',
      '    "userGoal": "Compact statement of the user job this deck satisfies",',
      '    "assumptions": ["Safe assumption used instead of blocking for more input"],',
      '    "openQuestions": [],',
      '    "acceptanceChecks": ["Medium-specific checks the final artifact should satisfy"],',
      '    "verificationNotes": ["Checks already run or still required for the target medium"]',
      '  },',
      '  "slides": [',
      '    {',
      '      "layout": "title|content|section|image|two-column|chart",',
      '      "kicker": "Optional slide eyebrow",',
      '      "title": "Slide Title",',
      '      "subtitle": "Optional supporting line",',
      '      "content": "Main content text (for content slides)",',
      '      "bullets": ["Point 1", "Point 2", "Point 3"],',
      '      "stats": [',
      '        { "label": "Metric", "value": "42%", "detail": "Optional context" }',
      '      ],',
      '      "columns": [',
      '        {',
      '          "heading": "Optional column heading",',
      '          "content": "Optional column content",',
      '          "bullets": ["Optional", "Column bullets"]',
      '        }',
      '      ],',
      '      "chart": {',
      '        "title": "Optional chart title",',
      '        "type": "bar|line|comparison",',
      '        "summary": "Takeaway from the chart",',
      '        "series": [',
      '          { "label": "Label", "value": 42 }',
      '        ]',
      '      },',
      '      "imagePrompt": "Description for AI image generation (optional, for visual slides)",',
      '      "imageUrl": "Optional direct image URL when a verified source image is already available",',
      '      "imageAlt": "Optional alt text for the image",',
      '      "imageSource": "Optional image attribution or source label"',
      '    }',
      '  ]',
      '}',
      '</output_contract>',
      '<rules>',
      '- First slide must use the "title" layout.',
      '- Use "section" layout for major narrative pivots.',
      '- Use "image" layout for slides that benefit from visuals.',
      '- Use "content" layout for explanation slides and "two-column" for comparisons or parallel tracks.',
      '- Use "chart" only when you can provide explicit series data.',
      '- Treat template names, examples, and sample structures as inspiration. Do not rigidly clone one template unless the request explicitly asks for it.',
      '- If the request would benefit from a hybrid structure, combine patterns from multiple templates into one coherent deck.',
      '- Keep bullet points concise, roughly 10-15 words max.',
      '- Image prompts should be vivid, specific, and visually directive.',
      '- Background direction matters: each slide should have a clear surface system for canvas, panel, image area, chart area, and caption text.',
      '- Slides should feel presentation-ready, not like a memo split into pages.',
      '- Populate metadata.userGoal, assumptions, openQuestions, acceptanceChecks, and verificationNotes so the deck carries the creation decisions and final-fit criteria forward.',
      '- Do not output markdown fences, prose commentary, or anything outside the JSON object.',
      '</rules>',
    ].filter(Boolean).join('\n');

    try {
      const result = await this.requestJson({
        messages: [{ role: 'user', content: prompt }],
        model: options.model || 'gpt-4o',
        reasoningEffort: resolveDocumentReasoningEffort(options),
      });

      const normalized = this.normalizePresentationStructure(result, {
        ...options,
        defaultTitle: topic,
        includeImages,
      });

      return this.applyPresentationQualityPass(topic, normalized, {
        ...options,
        designPlan,
        documentType: options.documentType || 'presentation',
        format: options.format || 'pptx',
      });
    } catch (error) {
      console.error('[AIDocumentGenerator] Presentation generation failed:', error);
      // Return a basic structure on failure
      return this.normalizePresentationStructure({
        title: topic,
        subtitle: '',
        slides: [
          { layout: 'title', title: topic, subtitle: '' },
          { layout: 'content', title: 'Introduction', bullets: ['Overview of the topic'] }
        ]
      }, {
        ...options,
        defaultTitle: topic,
        includeImages,
      });
    }
  }

  buildPresentationQualityRevisionPrompt(topic = '', presentation = {}, options = {}) {
    const qualityPlan = buildDocumentQualityPlan({
      documentType: options.documentType || 'presentation',
      format: options.format || 'pptx',
      designPlan: options.designPlan || null,
    });
    const slides = Array.isArray(presentation.slides) ? presentation.slides : [];

    return [
      renderDocumentQualityPromptContext(qualityPlan),
      '<source_request>',
      String(topic || '').trim(),
      '</source_request>',
      options.templateContext ? '<template_context>' : null,
      options.templateContext || null,
      options.templateContext ? '</template_context>' : null,
      this.renderDesignPlanPrompt(options.designPlan),
      '<current_presentation_json>',
      JSON.stringify(presentation, null, 2),
      '</current_presentation_json>',
      '<revision_instructions>',
      '- Return only the revised JSON object using the same presentation schema.',
      `- Preserve exactly ${slides.length || options.slideCount || 'the requested number of'} slides unless the current draft has the wrong count.`,
      '- Keep one dominant idea per slide and improve title specificity, pacing, visual/background direction, charts, and image prompts.',
      '- Preserve factual claims and numeric values unless the current draft clearly contradicts the source request.',
      '- Add metadata.qualityStandard and metadata.qualityNotes summarizing the revision.',
      '- Preserve or add metadata.userGoal, assumptions, openQuestions, acceptanceChecks, and verificationNotes so the final deck is aligned with the user request and target medium.',
      '- Do not output markdown fences, commentary, or any text outside the JSON object.',
      '</revision_instructions>',
    ].filter(Boolean).join('\n');
  }

  async applyPresentationQualityPass(topic = '', presentation = {}, options = {}) {
    const qualityPlan = buildDocumentQualityPlan({
      documentType: options.documentType || 'presentation',
      format: options.format || 'pptx',
      designPlan: options.designPlan || null,
    });
    const qualitySummary = summarizeDocumentQualityPlan(qualityPlan);

    if (!this.shouldRunQualityPass(options)) {
      return {
        ...presentation,
        metadata: {
          ...(presentation.metadata || {}),
          qualityStandard: qualitySummary,
          qualityPassApplied: false,
          qualityPassSkipped: true,
        },
      };
    }

    try {
      const revised = await this.requestJson({
        messages: [
          {
            role: 'system',
            content: 'You are a presentation quality council. Run the specialist review passes silently, then return only corrected JSON.',
          },
          {
            role: 'user',
            content: this.buildPresentationQualityRevisionPrompt(topic, presentation, options),
          },
        ],
        model: options.qualityModel || options.model || 'gpt-4o',
        reasoningEffort: resolveDocumentReasoningEffort(options, 'qualityReasoningEffort'),
      });

      const normalized = this.normalizePresentationStructure(revised, {
        ...options,
        defaultTitle: presentation.title || topic,
      });

      return {
        ...normalized,
        metadata: {
          ...(normalized.metadata || {}),
          qualityStandard: normalized.metadata?.qualityStandard || qualitySummary,
          qualityPassApplied: true,
        },
      };
    } catch (error) {
      console.warn('[AIDocumentGenerator] Presentation quality pass failed:', error.message);
      return {
        ...presentation,
        metadata: {
          ...(presentation.metadata || {}),
          qualityStandard: qualitySummary,
          qualityPassApplied: false,
          qualityPassError: String(error.message || 'Quality pass failed').slice(0, 180),
        },
      };
    }
  }

  normalizePresentationStructure(content = {}, options = {}) {
    const includeImages = options.includeImages !== false;
    const slides = Array.isArray(content.slides) ? content.slides : [];
    const title = sanitizeVisibleDocumentText(content.title || options.defaultTitle || 'Presentation') || 'Presentation';

    return {
      title,
      subtitle: sanitizeVisibleDocumentText(content.subtitle || ''),
      theme: sanitizeVisibleDocumentText(content.theme || options.theme || options.style || 'editorial') || 'editorial',
      metadata: {
        ...(content.metadata || {}),
      },
      slides: slides.map((slide, index) => {
        const imagePrompt = sanitizeVisibleDocumentText(slide.imagePrompt || '');
        return {
          layout: slide.layout || (index === 0 ? 'title' : 'content'),
          kicker: sanitizeVisibleDocumentText(slide.kicker || ''),
          title: sanitizeVisibleDocumentText(slide.title || `Slide ${index + 1}`) || `Slide ${index + 1}`,
          subtitle: sanitizeVisibleDocumentText(slide.subtitle || ''),
          content: typeof slide.content === 'string' ? sanitizeVisibleDocumentText(slide.content) : '',
          bullets: this.normalizeStringList(slide.bullets || slide.points),
          stats: this.normalizeStats(slide.stats || slide.metrics),
          columns: this.normalizeColumns(slide.columns),
          chart: this.normalizeChart(slide.chart),
          imagePrompt,
          imageUrl: slide.imageUrl || '',
          imageAlt: sanitizeVisibleDocumentText(slide.imageAlt || ''),
          imageSource: sanitizeVisibleDocumentText(slide.imageSource || ''),
          generateImage: !!imagePrompt && includeImages,
        };
      }),
    };
  }

  normalizeColumns(columns = []) {
    if (!Array.isArray(columns)) {
      return [];
    }

    return columns
      .filter((column) => column && typeof column === 'object')
      .map((column) => ({
        heading: sanitizeVisibleDocumentText(column.heading || ''),
        content: typeof column.content === 'string' ? sanitizeVisibleDocumentText(column.content) : '',
        bullets: this.normalizeStringList(column.bullets || column.points),
      }))
      .filter((column) => column.heading || column.content || column.bullets.length > 0);
  }

  normalizeStringList(value) {
    if (Array.isArray(value)) {
      return value
        .map((entry) => sanitizeVisibleDocumentText(entry))
        .filter(Boolean);
    }

    if (typeof value === 'string') {
      return value
        .split('\n')
        .map((entry) => sanitizeVisibleDocumentText(entry.replace(/^[-*]\s*/, '')))
        .filter(Boolean);
    }

    return [];
  }

  normalizeStats(stats = []) {
    if (!Array.isArray(stats)) {
      return [];
    }

    return stats
      .map((stat) => {
        if (stat == null) {
          return null;
        }

        if (typeof stat === 'string') {
          return { label: sanitizeVisibleDocumentText(stat), value: '', detail: '' };
        }

        const rawLabel = stat.label || stat.name || '';
        const label = sanitizeVisibleDocumentText(rawLabel);
        if (rawLabel && !label) {
          return null;
        }

        return {
          label: label || 'Metric',
          value: stat.value != null ? sanitizeVisibleDocumentText(String(stat.value)) : '',
          detail: sanitizeVisibleDocumentText(stat.detail || stat.context || ''),
        };
      })
      .filter((stat) => stat && (stat.label || stat.value || stat.detail));
  }

  normalizeCallout(callout) {
    if (!callout) {
      return null;
    }

    if (typeof callout === 'string') {
      return {
        title: '',
        body: sanitizeVisibleDocumentText(callout),
        tone: 'note',
      };
    }

    return {
      title: sanitizeVisibleDocumentText(callout.title || ''),
      body: sanitizeVisibleDocumentText(callout.body || callout.content || callout.text || ''),
      tone: callout.tone || 'note',
    };
  }

  normalizeTable(table) {
    if (!table || typeof table !== 'object') {
      return null;
    }

    const headers = Array.isArray(table.headers)
      ? table.headers.map((entry) => sanitizeVisibleDocumentText(entry)).filter(Boolean)
      : [];
    const rows = Array.isArray(table.rows)
      ? table.rows
        .map((row) => Array.isArray(row) ? row.map((cell) => sanitizeVisibleDocumentText(cell)) : [])
        .filter((row) => row.some(Boolean))
      : [];

    if (headers.length === 0 && rows.length === 0) {
      return null;
    }

    return {
      caption: sanitizeVisibleDocumentText(table.caption || ''),
      headers,
      rows,
    };
  }

  normalizeChart(chart) {
    if (!chart || typeof chart !== 'object') {
      return null;
    }

    const series = Array.isArray(chart.series)
      ? chart.series
        .map((point) => {
          if (!point || typeof point !== 'object') {
            return null;
          }

          return {
            label: sanitizeVisibleDocumentText(point.label || point.name || ''),
            value: point.value != null ? point.value : '',
          };
        })
        .filter((point) => point && point.label)
      : [];

    if (series.length === 0) {
      return null;
    }

    return {
      title: sanitizeVisibleDocumentText(chart.title || ''),
      type: chart.type || 'bar',
      summary: sanitizeVisibleDocumentText(chart.summary || ''),
      series,
    };
  }

  /**
   * Generate suggestions for document improvement
   * @param {Object} document - Document structure
   * @returns {Promise<Array>} Suggestions
   */
  async generateSuggestions(document) {
    const prompt = `Review the following document outline and suggest improvements:

Title: ${document.title}
Sections:
${document.sections.map(s => `- ${s.heading}`).join('\n')}

Return JSON array of suggestions:
[
  {
    "type": "add|remove|modify|reorder",
    "target": "section name or 'general'",
    "suggestion": "Description of the change",
    "reason": "Why this change would improve the document"
  }
]`;

    try {
      const result = await this.requestJson({
        messages: [{ role: 'user', content: prompt }],
        model: 'gpt-4o-mini',
      });

      return Array.isArray(result) ? result : (result.suggestions || []);
    } catch (error) {
      return [];
    }
  }
}

module.exports = { AIDocumentGenerator };

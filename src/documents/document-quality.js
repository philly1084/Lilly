const DOCUMENT_QUALITY_STANDARD_VERSION = 'document-quality-2026-05-k26-creation-loop';

const KIMI_CREATION_LOOP = [
  {
    id: 'intent-lock',
    label: 'Intent lock',
    focus: 'Restate the real user job, audience, delivery format, and success condition before choosing structure.',
  },
  {
    id: 'context-decisions',
    label: 'Context decisions',
    focus: 'Separate known facts, inferred defaults, missing blockers, and optional nice-to-have details.',
  },
  {
    id: 'artifact-architecture',
    label: 'Artifact architecture',
    focus: 'Choose sections, reader journey, visual system, evidence plan, and export path before drafting.',
  },
  {
    id: 'build-and-render',
    label: 'Build and render',
    focus: 'Create the actual document or sandbox source with assets, styles, print rules, and target-format constraints.',
  },
  {
    id: 'critic-repair',
    label: 'Critic and repair',
    focus: 'Review rendered output against acceptance checks, then fix visible layout, content, or export issues.',
  },
  {
    id: 'handoff-proof',
    label: 'Handoff proof',
    focus: 'Return final artifact links plus assumptions, checks run, fixed issues, and remaining limits.',
  },
];

const QUALITY_AGENT_PASSES = [
  {
    id: 'strategy-architect',
    label: 'Strategy Architect',
    focus: 'Confirms the artifact has the right document type, audience fit, argument order, and decision path.',
  },
  {
    id: 'background-art-director',
    label: 'Background Art Director',
    focus: 'Creates an intentional background system with readable page, panel, band, chart, and image-overlay surfaces.',
  },
  {
    id: 'evidence-editor',
    label: 'Evidence Editor',
    focus: 'Keeps claims grounded, turns facts into implications, and avoids invented precision.',
  },
  {
    id: 'accessibility-reviewer',
    label: 'Accessibility Reviewer',
    focus: 'Checks contrast, mobile/print readability, table clarity, clipped labels, and overlapping text risk.',
  },
  {
    id: 'final-polish-editor',
    label: 'Final Polish Editor',
    focus: 'Removes template residue, generic headings, repeated phrasing, placeholders, and process notes.',
  },
];

const FORMAT_FOCUS = {
  html: [
    'Design the first screen as a composed reading surface with a clear background/page/panel relationship.',
    'Use section rhythm, cards, callouts, tables, charts, and verified images only where they improve comprehension.',
    'Assume responsive browser QA will check contrast, overflow, broken images, and page errors.',
  ],
  pdf: [
    'Use browser-renderable HTML discipline first, then print-safe surfaces with dark text on light pages unless a dark panel is explicit.',
    'Declare the intended PDF page geometry in source HTML with an explicit @page size and margin rule; design sections, tables, images, and page breaks for that geometry instead of assuming a later converter will resize or crop safely.',
    'Keep PDF layouts inside the printable content box: no fixed-width shells wider than the page after margins, no unwrapped long code or URLs, and no tables that rely on horizontal scrolling.',
    'For PDF section rhythm, prefer a single clean divider, spacing, or heading band between major sections; avoid full bordered cards around every section because page breaks can create awkward double borders.',
    'Keep page density balanced: no tiny tables, clipped labels, or decorative backgrounds that print poorly.',
    'Use executive summary, evidence blocks, and references/caveats where the document type calls for them.',
  ],
  pptx: [
    'Build a slide story with one dominant idea per slide and visible scene-to-scene pacing.',
    'Use image prompts, chart slides, and section resets as design primitives rather than decoration.',
    'Keep slide copy short enough to present, not a memo pasted into slide boxes.',
  ],
  xlsx: [
    'Treat workbook tabs as a designed information product: overview first, then data, tables, charts, and notes.',
    'Make sheets scannable with clear labels, useful chart data, and interpretation beside the numbers.',
  ],
  md: [
    'Optimize for portable reading: clear headings, concise prose, useful lists, and preserved evidence boundaries.',
    'Use markdown tables and callouts only when they remain readable as plain text.',
  ],
};

function normalizeFormat(format = 'html') {
  const normalized = String(format || 'html').trim().toLowerCase();
  if (normalized === 'markdown') {
    return 'md';
  }
  return normalized || 'html';
}

function normalizeDocumentTypeLabel(documentType = 'document') {
  return String(documentType || 'document').trim().toLowerCase() || 'document';
}

function buildDocumentQualityPlan({
  documentType = 'document',
  format = 'html',
  designPlan = null,
} = {}) {
  const normalizedFormat = normalizeFormat(format);
  const selectedLayout = designPlan?.selectedDesignOption || designPlan?.layoutChoice || null;

  return {
    version: DOCUMENT_QUALITY_STANDARD_VERSION,
    passName: 'Kimi K2.6-style creation loop with context, steps, critique, and proof',
    standard: 'publication-ready',
    documentType: normalizeDocumentTypeLabel(documentType),
    format: normalizedFormat,
    modelDefaults: [
      'Use the strongest configured generation model unless the caller explicitly supplies a model.',
      'Spend reasoning on document architecture, visual composition, evidence boundaries, and final polish before emitting JSON.',
      'Prefer specific, edited content over broad "professional" filler.',
    ],
    interactionBrief: {
      stateMachine: [
        'brief_scan: extract known format, audience, purpose, source material, constraints, and acceptance checks.',
        'missing_context: decide whether gaps are blockers or safe defaults.',
        'question_or_default: ask one or two concise questions only for blockers; otherwise continue with assumptions in metadata or handoff notes.',
        'architecture: choose the document structure, reader jobs, and evidence path before drafting.',
        'quality_pass: reconcile strategy, design, evidence, accessibility, and final polish into the generated artifact.',
        'medium_check: verify the target medium requirements before calling the document complete.',
      ],
      fields: [
        'format',
        'audience',
        'purpose',
        'required sections',
        'source material',
        'tone',
        'length',
        'visual/data assets',
        'constraints',
        'acceptance checks',
      ],
      rules: [
        'Infer conservative professional defaults from the request, session context, selected template, and source artifacts before asking the user for more information.',
        'Ask one or two concise follow-up questions only when missing details would materially change the document or block a credible draft.',
        'If the user wants speed or the missing detail is not a blocker, continue with explicit assumptions in metadata or handoff notes rather than visible process chatter.',
        'For document requests, never ship a generic filler draft just because the prompt is short; use the brief to choose structure, evidence needs, and reader jobs.',
      ],
    },
    userAlignment: {
      label: 'User alignment snapshot',
      fields: [
        'userGoal',
        'audience',
        'format',
        'purpose',
        'assumptions',
        'openQuestions',
        'acceptanceChecks',
        'verificationPlan',
      ],
      rules: [
        'Keep a compact alignment snapshot in metadata or handoff notes so follow-up agents can see what was inferred and why.',
        'Open questions should be empty unless the missing information would materially change the artifact.',
        'Acceptance checks should be concrete and medium-specific, such as readable PDF page breaks, working sandbox preview, cited current facts, or editable source bundle preserved.',
        'Verification notes must distinguish checks already run from checks that still need the target runtime or user review.',
      ],
    },
    creationLoop: KIMI_CREATION_LOOP.map((entry) => ({ ...entry })),
    backgroundDirection: {
      label: selectedLayout?.label
        ? `${selectedLayout.label} background system`
        : 'Document background system',
      rules: [
        'Treat background creation as part of the document, not decoration added after writing.',
        'Define a readable hierarchy for canvas background, page surface, panels, dark bands, image overlays, tables, charts, captions, and muted text.',
        'Use subtle texture, grid, editorial bands, or section washes only when they help orientation; never let background treatment compete with body copy.',
        'For text over imagery, require a solid or strongly translucent overlay and explicit color/background pairing.',
        'For print/PDF, preserve a light readable page surface unless a dark printed panel has its own high-contrast text color.',
      ],
    },
    agentPasses: QUALITY_AGENT_PASSES.map((entry) => ({ ...entry })),
    formatFocus: FORMAT_FOCUS[normalizedFormat] || FORMAT_FOCUS.html,
    completionGate: [
      'The artifact must look intentional before it reads clever.',
      'No white-on-white, dark-on-dark, placeholder sections, generic numbered scaffolds, or visible process notes.',
      'Short or underspecified prompts still need a real document brief, safe assumptions, and request-specific structure.',
      'Every section should justify its presence through a reader job: decide, understand, compare, execute, or remember.',
      'Tables, charts, stats, and callouts need labels and interpretation, not just raw values.',
      'If sources are incomplete, state limits as document content without exposing tool workflow details.',
      'The final handoff must make it clear what was generated, which assumptions shaped it, which checks ran, and what still needs user approval or target-medium verification.',
    ],
  };
}

function renderDocumentQualityPromptContext(planOrOptions = null) {
  const qualityPlan = planOrOptions?.version
    ? planOrOptions
    : buildDocumentQualityPlan(planOrOptions || {});

  const lines = [
    `<quality_standard version="${qualityPlan.version}">`,
    `Pass: ${qualityPlan.passName}`,
    'Apply this standard automatically. The user should not need to ask for better design prompts, background direction, or a quality review pass.',
    '<model_quality_defaults>',
    ...qualityPlan.modelDefaults.map((entry) => `- ${entry}`),
    '</model_quality_defaults>',
    '<document_intake>',
    'State machine:',
    ...qualityPlan.interactionBrief.stateMachine.map((entry) => `- ${entry}`),
    `Brief fields: ${qualityPlan.interactionBrief.fields.join(', ')}`,
    ...qualityPlan.interactionBrief.rules.map((entry) => `- ${entry}`),
    '</document_intake>',
    '<kimi_creation_loop>',
    'Use a Kimi K2.6-style creation loop: visible confidence should come from context, deliberate steps, critique, repair, and proof rather than generic polish language.',
    ...qualityPlan.creationLoop.map((entry) => `- ${entry.label} [${entry.id}]: ${entry.focus}`),
    '</kimi_creation_loop>',
    '<user_alignment_snapshot>',
    `Fields: ${qualityPlan.userAlignment.fields.join(', ')}`,
    ...qualityPlan.userAlignment.rules.map((entry) => `- ${entry}`),
    '</user_alignment_snapshot>',
    '<background_creation>',
    `Direction: ${qualityPlan.backgroundDirection.label}`,
    ...qualityPlan.backgroundDirection.rules.map((entry) => `- ${entry}`),
    '</background_creation>',
    '<multi_agent_design_pass>',
    'Before final output, internally run these specialist passes and reconcile them into one coherent artifact. Do not mention the pass names in visible document copy.',
    ...qualityPlan.agentPasses.map((entry) => `- ${entry.label} [${entry.id}]: ${entry.focus}`),
    '</multi_agent_design_pass>',
    '<format_quality_focus>',
    ...qualityPlan.formatFocus.map((entry) => `- ${entry}`),
    '</format_quality_focus>',
    '<completion_gate>',
    ...qualityPlan.completionGate.map((entry) => `- ${entry}`),
    '</completion_gate>',
    '</quality_standard>',
  ];

  return lines.join('\n');
}

function summarizeDocumentQualityPlan(planOrOptions = null) {
  const qualityPlan = planOrOptions?.version
    ? planOrOptions
    : buildDocumentQualityPlan(planOrOptions || {});

  return {
    version: qualityPlan.version,
    passName: qualityPlan.passName,
    standard: qualityPlan.standard,
    format: qualityPlan.format,
    agentPasses: qualityPlan.agentPasses.map((entry) => entry.id),
    creationLoop: qualityPlan.creationLoop.map((entry) => entry.id),
    userAlignmentFields: qualityPlan.userAlignment.fields.slice(),
    backgroundDirection: qualityPlan.backgroundDirection.label,
    completionGate: qualityPlan.completionGate.slice(0, 3),
  };
}

module.exports = {
  DOCUMENT_QUALITY_STANDARD_VERSION,
  KIMI_CREATION_LOOP,
  QUALITY_AGENT_PASSES,
  buildDocumentQualityPlan,
  renderDocumentQualityPromptContext,
  summarizeDocumentQualityPlan,
};

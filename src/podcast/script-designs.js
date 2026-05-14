const PODCAST_SCRIPT_DESIGNS = Object.freeze([
  {
    id: 'classic-explainer',
    label: 'Classic Explainer',
    summary: 'Hook, context, three clear learning beats, practical wrap-up.',
    guidance: 'Use a clean teaching arc with crisp transitions and concrete examples. Keep the hosts focused on the subject, not on their own process.',
  },
  {
    id: 'investigative-thread',
    label: 'Investigative Thread',
    summary: 'Start with a question, follow evidence, resolve what is known and unknown.',
    guidance: 'Let curiosity drive the structure. Each segment should answer one question and raise the next without turning into detective-roleplay.',
  },
  {
    id: 'debate-with-receipts',
    label: 'Debate With Receipts',
    summary: 'Two informed perspectives test claims against sources.',
    guidance: 'Create respectful tension around tradeoffs. Every challenge should land on evidence or a practical implication, not performative disagreement.',
  },
  {
    id: 'field-guide',
    label: 'Field Guide',
    summary: 'Listener learns what to notice, what matters, and what to ignore.',
    guidance: 'Make the episode feel like a practical guide. Use labels, signals, pitfalls, and rules of thumb without sounding like a checklist read aloud.',
  },
  {
    id: 'story-then-analysis',
    label: 'Story Then Analysis',
    summary: 'Open with a grounded mini-story, then unpack why it matters.',
    guidance: 'Use one vivid scenario as the doorway into the topic. Do not overdramatize; return to clear analysis after the story beat.',
  },
  {
    id: 'myth-vs-reality',
    label: 'Myth Vs Reality',
    summary: 'Name common assumptions, correct them, and explain the better model.',
    guidance: 'Frame each segment around a misconception and a more useful truth. Avoid dunking on the listener or repeating the same correction in new words.',
  },
  {
    id: 'executive-briefing',
    label: 'Executive Briefing',
    summary: 'Fast, useful briefing for decisions, risks, and next moves.',
    guidance: 'Prioritize implications, decision points, and risk. Keep the language plain and high-signal, with minimal banter.',
  },
  {
    id: 'documentary-narrative',
    label: 'Documentary Narrative',
    summary: 'A polished audio documentary arc with scenes, context, and stakes.',
    guidance: 'Build momentum through scene-like beats and carefully paced context. Spoken lines should stay natural; no stage directions or narrator self-commentary.',
  },
  {
    id: 'roundtable-brief',
    label: 'Roundtable Brief',
    summary: 'Conversational review of what happened, why, and what changes.',
    guidance: 'Make the hosts sound prepared and concise. Use handoffs that add new information instead of restating the same emotional emphasis.',
  },
  {
    id: 'beginner-friendly',
    label: 'Beginner Friendly',
    summary: 'Simple analogies, low jargon, and patient explanations.',
    guidance: 'Define terms in context and use plain examples. Respect the listener; avoid baby-talk, filler reassurance, and repeated framing speeches.',
  },
  {
    id: 'technical-deep-dive',
    label: 'Technical Deep Dive',
    summary: 'Dense but listenable explanation for technical audiences.',
    guidance: 'Use precise terms and causal chains. Break complexity into spoken chunks, and do not pad with meta explanations about why the pacing is technical.',
  },
  {
    id: 'training-podcast',
    label: 'Training Podcast',
    summary: 'Calm instructor-led session with objectives, core principles, worked examples, checks for understanding, and a final recap.',
    guidance: 'Teach from source material like a structured technical training session. Open with learning objectives, pre-teach prerequisite terms, segment the topic into named modules, use verbal signposts, explain one principle at a time, give worked examples and common mistakes, pause with brief comprehension checks, and close with a practical recap. Keep the voice calm, calculated, precise, and human; avoid hype, rambling banter, and lecture-note stiffness.',
  },
  {
    id: 'news-magazine',
    label: 'News Magazine',
    summary: 'Topline, background, consequences, and what to watch next.',
    guidance: 'Keep the episode timely and structured like a smart feature segment. Separate facts, context, and outlook clearly.',
  },
  {
    id: 'case-study',
    label: 'Case Study',
    summary: 'One example carries the episode from setup through lessons learned.',
    guidance: 'Anchor the episode in a specific case. Move from what happened to what it teaches, without forcing a neat moral if the evidence is mixed.',
  },
  {
    id: 'contrarian-but-fair',
    label: 'Contrarian But Fair',
    summary: 'Challenge the obvious take while staying evidence-grounded.',
    guidance: 'Surface overlooked angles and incentives. Do not make the hosts sound smug; make the reasoning useful and balanced.',
  },
  {
    id: 'how-it-works',
    label: 'How It Works',
    summary: 'Mechanism-first explanation with step-by-step causal flow.',
    guidance: 'Explain the machinery of the topic in order. Use transitions that move the listener forward, not repeated declarations about unpacking complexity.',
  },
  {
    id: 'decision-tree',
    label: 'Decision Tree',
    summary: 'If-this-then-that structure for choices and tradeoffs.',
    guidance: 'Organize the episode around decision branches. Make each branch concrete with conditions, consequences, and common mistakes.',
  },
  {
    id: 'timeline-arc',
    label: 'Timeline Arc',
    summary: 'Past, present, and near-future progression.',
    guidance: 'Use chronology to create clarity. Avoid dry history lecture; each time shift should explain why the current moment makes more sense.',
  },
  {
    id: 'problem-solution',
    label: 'Problem Solution',
    summary: 'Define the pain, test solutions, and close with realistic next steps.',
    guidance: 'Keep the problem specific and the solutions honest. Avoid motivational filler and repeated empathy beats that do not add information.',
  },
  {
    id: 'compare-and-choose',
    label: 'Compare And Choose',
    summary: 'Compare options against criteria, then explain the best fit.',
    guidance: 'Use consistent comparison criteria. Make tradeoffs audible and useful instead of listing features.',
  },
  {
    id: 'human-impact',
    label: 'Human Impact',
    summary: 'Explain the issue through lived consequences and practical stakes.',
    guidance: 'Bring people into the story without manufacturing sentiment. Ground emotional beats in facts and specific consequences.',
  },
]);

const PODCAST_SCRIPT_DESIGN_IDS = new Set(PODCAST_SCRIPT_DESIGNS.map((design) => design.id));

function normalizePodcastScriptDesignId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function resolvePodcastScriptDesign(value = '') {
  const normalized = normalizePodcastScriptDesignId(value);
  if (!normalized) {
    return null;
  }

  return PODCAST_SCRIPT_DESIGNS.find((design) => (
    design.id === normalized
    || normalizePodcastScriptDesignId(design.label) === normalized
  )) || null;
}

function getPodcastScriptDesignOptions() {
  return PODCAST_SCRIPT_DESIGNS.map((design) => ({ ...design }));
}

module.exports = {
  PODCAST_SCRIPT_DESIGN_IDS,
  getPodcastScriptDesignOptions,
  normalizePodcastScriptDesignId,
  resolvePodcastScriptDesign,
};

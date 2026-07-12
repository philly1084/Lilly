const express = require('express');
const { skillStore } = require('../skills/skill-store');
const { createResponse } = require('../openai-client');
const { extractResponseText } = require('../artifacts/artifact-service');
const { parseLenientJson } = require('../utils/lenient-json');
const { getToolManager } = require('../agent-sdk/tools');

const router = express.Router();
const MAX_TOOL_CATALOG_ITEMS = 80;

function normalizeString(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeStringList(value = []) {
  const list = Array.isArray(value) ? value : [value];
  return Array.from(new Set(
    list
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
  )).slice(0, 40);
}

function normalizeContextMaxChars(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(600, Math.min(parsed, 6000))
    : 1800;
}

function normalizeDraftSkill(value = {}) {
  const draft = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    id: normalizeString(draft.id),
    name: normalizeString(draft.name || draft.title),
    description: normalizeString(draft.description),
    body: String(draft.body || draft.instructions || '').trim(),
    tools: normalizeStringList(draft.tools || draft.toolIds || draft.tool_ids),
    triggerPatterns: normalizeStringList(draft.triggerPatterns || draft.trigger_patterns || draft.triggers || draft.keywords),
    chain: Array.isArray(draft.chain || draft.steps)
      ? (draft.chain || draft.steps).slice(0, 16)
      : [],
    contextPolicy: {
      maxChars: normalizeContextMaxChars(
        draft.contextPolicy?.maxChars
        || draft.contextPolicy?.max_chars
        || draft.context_policy?.maxChars
        || draft.context_policy?.max_chars
        || 1800,
      ),
      exposeBody: (
        draft.contextPolicy?.exposeBody
        ?? draft.contextPolicy?.expose_body
        ?? draft.context_policy?.exposeBody
        ?? draft.context_policy?.expose_body
      ) !== false,
    },
  };
}

function normalizeQuestions(value = []) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((entry) => {
      if (typeof entry === 'string') {
        return {
          id: '',
          question: normalizeString(entry),
          inputType: 'text',
          options: [],
        };
      }
      return {
        id: normalizeString(entry?.id),
        question: normalizeString(entry?.question || entry?.prompt || entry?.ask),
        inputType: normalizeString(entry?.inputType || entry?.input_type || entry?.type || 'text') || 'text',
        options: Array.isArray(entry?.options)
          ? entry.options
            .map((option) => (typeof option === 'string'
              ? { label: normalizeString(option), description: '' }
              : {
                label: normalizeString(option?.label || option?.title || option?.text),
                description: normalizeString(option?.description || option?.details),
              }))
            .filter((option) => option.label)
            .slice(0, 5)
          : [],
      };
    })
    .filter((entry) => entry.question)
    .slice(0, 6);
}

async function buildToolCatalogForDraft() {
  const toolManager = getToolManager();
  await toolManager.initialize();
  return toolManager.registry.getFrontendTools()
    .slice(0, MAX_TOOL_CATALOG_ITEMS)
    .map((tool) => ({
      id: tool.id,
      name: tool.name,
      category: tool.category,
      description: tool.description,
      parameters: Array.isArray(tool.parameters)
        ? tool.parameters.map((param) => ({
          name: param.name,
          required: param.required === true,
          description: param.description || '',
        })).slice(0, 8)
        : [],
    }));
}

function buildSkillDraftPrompt({
  ask = '',
  answers = [],
  currentDraft = null,
  toolCatalog = [],
} = {}) {
  return [
    'You are the KimiBuilt skill creator helper.',
    'Design one registered agent skill that complements tools without duplicating a tool.',
    'The skill should preserve low context exposure: compact triggers, explicit tool affinities, concise chain, and only essential instructions.',
    'Use the provided tool catalog. Do not invent tool ids.',
    'Ask only the next useful questions needed to design the right skill. Prefer 1 to 3 questions at a time.',
    'When enough information is available, set readyForApproval true and provide a complete draft for final user approval.',
    'Return JSON only with this shape:',
    '{"summary":"short status","readyForApproval":false,"questions":[{"id":"...","question":"...","inputType":"text|choice|multi-choice","options":[{"label":"...","description":"..."}]}],"draft":{"id":"","name":"","description":"","body":"","tools":[],"triggerPatterns":[],"chain":[],"contextPolicy":{"maxChars":1800,"exposeBody":true}},"rationale":"short reason"}',
    '',
    'Initial user ask:',
    ask || '(empty)',
    '',
    'Answers collected so far:',
    JSON.stringify(Array.isArray(answers) ? answers : [], null, 2),
    '',
    'Current draft, if any:',
    JSON.stringify(currentDraft || null, null, 2),
    '',
    'Available tools:',
    JSON.stringify(toolCatalog, null, 2),
  ].join('\n');
}

async function draftSkillWithModel(input = {}) {
  const ask = normalizeString(input.ask || input.initialAsk || input.request);
  const answers = Array.isArray(input.answers) ? input.answers : [];
  const currentDraft = input.currentDraft && typeof input.currentDraft === 'object'
    ? normalizeDraftSkill(input.currentDraft)
    : null;
  if (!ask) {
    throw new Error('Skill wizard needs an initial ask.');
  }

  const toolCatalog = await buildToolCatalogForDraft();
  const response = await createResponse({
    input: buildSkillDraftPrompt({
      ask,
      answers,
      currentDraft,
      toolCatalog,
    }),
    instructions: 'You are a precise JSON-producing workflow designer for KimiBuilt registered skills.',
    stream: false,
    reasoningEffort: input.reasoningEffort || 'low',
    requestTimeoutMs: 60000,
  });
  const text = extractResponseText(response).trim();
  const parsed = parseLenientJson(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Skill draft model response was not parseable JSON.');
  }

  const allowedToolIds = new Set(toolCatalog.map((tool) => tool.id));
  const draft = normalizeDraftSkill(parsed.draft || {});
  draft.tools = draft.tools.filter((toolId) => allowedToolIds.has(toolId));

  return {
    summary: normalizeString(parsed.summary || parsed.rationale || 'Skill draft updated.'),
    readyForApproval: parsed.readyForApproval === true || parsed.ready_for_approval === true,
    questions: normalizeQuestions(parsed.questions),
    draft,
    rationale: normalizeString(parsed.rationale),
    toolCatalog,
  };
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function firstQueryValue(query = {}, keys = []) {
  for (const key of keys) {
    const value = query[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function splitQueryList(value = '') {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

router.get('/', (req, res, next) => {
  try {
    const skills = skillStore.listSkills({
      search: req.query.search || req.query.q || '',
      includeDisabled: parseBoolean(req.query.includeDisabled, false),
      includeBody: parseBoolean(req.query.includeBody, false),
    });

    res.json({
      success: true,
      data: skills,
      meta: skillStore.getSummary(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/context', (req, res, next) => {
  try {
    const selectedSkillIds = splitQueryList(firstQueryValue(req.query, ['skillIds', 'skills', 'skill_ids']));
    const toolIds = splitQueryList(firstQueryValue(req.query, ['toolIds', 'tools', 'tool_ids']));
    const capabilityNeeds = splitQueryList(firstQueryValue(req.query, ['capabilityNeeds', 'capabilities', 'capability_needs']));
    const skillContext = skillStore.buildContext({
      text: req.query.q || req.query.text || '',
      toolIds,
      selectedSkillIds,
      limit: req.query.limit,
      surface: firstQueryValue(req.query, ['surface', 'clientSurface', 'client_surface']),
      taskType: firstQueryValue(req.query, ['taskType', 'activeMode', 'task_type', 'active_mode']),
      capabilityNeeds,
    });

    res.json({
      success: true,
      data: {
        context: skillContext.block,
        selectedSkills: skillContext.selectedSkills,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/draft', async (req, res, next) => {
  try {
    const draft = await draftSkillWithModel(req.body || {});
    res.json({
      success: true,
      data: draft,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const skill = skillStore.readSkill(req.params.id, {
      includeBody: parseBoolean(req.query.includeBody, true),
    });

    if (!skill) {
      return res.status(404).json({ success: false, error: 'Skill not found' });
    }

    return res.json({ success: true, data: skill });
  } catch (error) {
    return next(error);
  }
});

router.post('/', (req, res, next) => {
  try {
    const skill = skillStore.upsertSkill(req.body || {}, { createOnly: true });
    res.status(201).json({ success: true, data: skill, meta: skillStore.getSummary() });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', (req, res, next) => {
  try {
    const skill = skillStore.upsertSkill({
      ...(req.body || {}),
      id: req.params.id,
    });
    res.json({ success: true, data: skill, meta: skillStore.getSummary() });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const deleted = skillStore.deleteSkill(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Skill not found' });
    }

    return res.json({ success: true, data: { id: req.params.id, deleted: true }, meta: skillStore.getSummary() });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

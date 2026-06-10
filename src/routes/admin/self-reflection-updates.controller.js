const crypto = require('crypto');
const {
  SELF_REFLECTION_UPDATE_TOOL_ID,
  applySelfReflectionUpdate,
  readSelfReflectionUpdates,
} = require('../../self-reflection-updater');
const { sessionStore: defaultSessionStore } = require('../../session-store');
const afterProcessAuditsController = require('./after-process-audits.controller');
const {
  buildApprovedAfterProcessToolFailureHint,
  mergeApprovedAfterProcessToolFailureHint,
} = require('../../after-process-audit-hints');

const DEFAULT_SUGGESTION_LIMIT = 10;
const DEFAULT_SESSION_SCAN_LIMIT = 100;
const APPLIED_SUGGESTION_MARKER = 'suggestion:';
const DURABLE_EVALUATOR_LESSON_PATTERNS = [
  /\bdurable\s+(?:lesson|learning|improvement|memory|note|guidance)\b/i,
  /\breusable\s+(?:lesson|guidance|pattern|rule|skill|routing)\b/i,
  /\bfor\s+similar\s+future\b/i,
  /\bfuture\s+(?:routing|requests|turns|workflows|evaluations|sessions)\b/i,
  /\bmodel[-\s]?card\s+(?:note|finding|lesson|evidence)\b/i,
];

function parseLimit(value, fallback = DEFAULT_SUGGESTION_LIMIT, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function normalizeInline(value = '', limit = 1000) {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value || '');
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeSuggestionInput(input = {}, entry = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};
  return {
    ...source,
    source: normalizeInline(source.source || 'alignment-evaluator', 120),
    trigger: normalizeInline(
      source.trigger
        || entry.reason
        || `alignment feedback ${entry.feedbackId || entry.evaluationId || ''}`,
      500,
    ),
    reflection: normalizeInline(source.reflection || entry.evaluation?.lesson || entry.reason || '', 1200),
    dryRun: true,
    apply: false,
    actions: Array.isArray(source.actions) ? source.actions : [],
  };
}

function hasDurableEvaluatorLesson(value = '') {
  const source = String(value || '');
  return DURABLE_EVALUATOR_LESSON_PATTERNS.some((pattern) => pattern.test(source));
}

function hasActionableEvaluatorFinding(evaluation = {}) {
  const failureCategories = Array.isArray(evaluation.failureCategories)
    ? evaluation.failureCategories
    : [];
  const toolMisuseCategories = Array.isArray(evaluation.toolMisuseCategories)
    ? evaluation.toolMisuseCategories
    : [];
  return evaluation.promoteRegressionFixture === true
    || ['wrong_route', 'route_unclear'].includes(String(evaluation.routeDecision || ''))
    || ['tool_gap', 'tool_misuse'].includes(String(evaluation.toolUseDecision || ''))
    || failureCategories.some((category) => category && category !== 'other')
    || toolMisuseCategories.some((category) => category && category !== 'other');
}

function firstNonEmpty(values = []) {
  return values.map((value) => normalizeInline(value || '', 700)).find(Boolean) || '';
}

function buildEvaluatorLessonSuggestion(entry = {}) {
  const evaluation = entry?.evaluation || {};
  const lesson = firstNonEmpty([
    evaluation.toolLesson,
    evaluation.lesson,
    ...(Array.isArray(evaluation.decisionGuidance) ? evaluation.decisionGuidance : []),
    ...(Array.isArray(evaluation.recommendedChanges) ? evaluation.recommendedChanges : []),
  ]);
  const cueText = [
    lesson,
    evaluation.summary,
    evaluation.routeDecision,
    ...(Array.isArray(evaluation.failureCategories) ? evaluation.failureCategories : []),
    ...(Array.isArray(evaluation.toolMisuseCategories) ? evaluation.toolMisuseCategories : []),
  ].join(' ');

  if (entry.rating !== 'down' || !lesson) {
    return null;
  }

  if (!hasDurableEvaluatorLesson(cueText) && !hasActionableEvaluatorFinding(evaluation)) {
    return null;
  }

  const content = hasDurableEvaluatorLesson(lesson)
    ? lesson
    : `Durable lesson: ${lesson}`;

  return {
    toolId: SELF_REFLECTION_UPDATE_TOOL_ID,
    status: 'suggested',
    appliesAutomatically: false,
    generatedFromEvaluation: true,
    input: {
      source: 'alignment-evaluator',
      trigger: 'model-card finding from alignment evaluator durable lesson',
      reflection: normalizeInline(evaluation.summary || lesson, 700),
      dryRun: true,
      apply: false,
      actions: [{
        type: 'model_card_note',
        content: normalizeInline(content, 900),
        reason: 'Durable evaluator lesson can be recorded as model-card evidence.',
      }],
    },
  };
}

function buildSuggestionId({ session = {}, entry = {}, suggestion = {}, index = 0 }) {
  const stableSource = JSON.stringify({
    sessionId: session.id || '',
    feedbackId: entry.feedbackId || entry.evaluationId || '',
    messageId: entry.messageId || '',
    index,
    input: suggestion.input || {},
  });
  const hash = crypto.createHash('sha1').update(stableSource).digest('hex').slice(0, 14);
  return `srs-${hash}`;
}

function buildAfterProcessAuditSuggestionId({ session = {}, audit = {}, suggestion = {}, index = 0 }) {
  const stableSource = JSON.stringify({
    sessionId: session.id || '',
    auditId: audit.auditId || '',
    completedAt: audit.completedAt || '',
    index,
    input: suggestion.input || {},
  });
  const hash = crypto.createHash('sha1').update(stableSource).digest('hex').slice(0, 14);
  return `srs-audit-${hash}`;
}

function normalizeAfterProcessAuditSuggestionInput(suggestion = {}, audit = {}) {
  const source = suggestion && typeof suggestion === 'object' && !Array.isArray(suggestion)
    ? suggestion
    : {};
  const input = source.input && typeof source.input === 'object' && !Array.isArray(source.input)
    ? source.input
    : source;
  const actions = Array.isArray(input.actions)
    ? input.actions
    : (source.action || source.note || source.content
      ? [{
        type: source.action === 'agent_notes_append' ? 'agent_notes_append' : 'model_card_note',
        content: normalizeInline(source.note || source.content || source.reflection || source.reason || '', 900),
        reason: normalizeInline(source.reason || 'After-process audit suggested a bounded durable lesson.', 300),
      }]
      : []);

  return {
    ...input,
    source: normalizeInline(input.source || 'after-process-audit', 120),
    trigger: normalizeInline(
      input.trigger
        || source.trigger
        || `after-process audit ${audit.auditId || ''}`,
      500,
    ),
    reflection: normalizeInline(
      input.reflection
        || source.reflection
        || source.reason
        || audit.summary
        || 'After-process audit suggested a durable tool-learning update.',
      1200,
    ),
    dryRun: true,
    apply: false,
    actions,
  };
}

function extractAppliedSuggestionIds() {
  const appliedIds = new Set();
  const data = readSelfReflectionUpdates({ limit: 200 });

  (data.updates || []).forEach((update) => {
    const haystack = [
      update.trigger,
      update.reflection,
      update.source,
      update.modelCardNote,
    ].map((value) => String(value || '')).join(' ');
    const matches = haystack.matchAll(/\[suggestion:([a-z0-9-]+)\]/gi);
    for (const match of matches) {
      if (match[1]) {
        appliedIds.add(match[1]);
      }
    }
  });

  return appliedIds;
}

function collectSuggestionsFromSession(session = {}, appliedIds = new Set()) {
  const metadata = session?.metadata || {};
  const history = Array.isArray(metadata.alignmentFeedbackHistory)
    ? metadata.alignmentFeedbackHistory
    : [];
  const current = metadata.alignmentFeedback && typeof metadata.alignmentFeedback === 'object'
    ? [metadata.alignmentFeedback]
    : [];
  const seenEntries = new Set();
  const entries = [...history, ...current].filter((entry) => {
    const entryId = `${entry?.feedbackId || entry?.evaluationId || ''}:${entry?.messageId || ''}`;
    if (seenEntries.has(entryId)) {
      return false;
    }
    seenEntries.add(entryId);
    return true;
  });

  const evaluatorSuggestions = entries.flatMap((entry = {}) => {
    const explicitSuggestions = Array.isArray(entry?.evaluation?.selfReflectionUpdateSuggestions)
      ? entry.evaluation.selfReflectionUpdateSuggestions
      : [];
    const generatedSuggestion = explicitSuggestions.length === 0
      ? buildEvaluatorLessonSuggestion(entry)
      : null;
    const suggestions = generatedSuggestion
      ? [generatedSuggestion]
      : explicitSuggestions;

    return suggestions
      .filter((suggestion) => {
        return !suggestion?.toolId || suggestion.toolId === SELF_REFLECTION_UPDATE_TOOL_ID;
      })
      .map((suggestion, index) => {
        const input = normalizeSuggestionInput(suggestion.input || {}, entry);
        const id = buildSuggestionId({ session, entry, suggestion: { ...suggestion, input }, index });
        const applied = appliedIds.has(id);
        return {
          id,
          status: applied ? 'applied' : normalizeInline(suggestion.status || 'suggested', 80),
          applied,
          canApply: !applied && input.actions.length > 0,
          toolId: SELF_REFLECTION_UPDATE_TOOL_ID,
          sessionId: session.id || '',
          messageId: entry.messageId || '',
          feedbackId: entry.feedbackId || entry.evaluationId || '',
          rating: entry.rating || '',
          reason: normalizeInline(entry.reason || '', 500),
          updatedAt: entry.updatedAt || session.updatedAt || '',
          evaluation: {
            lesson: normalizeInline(entry.evaluation?.lesson || '', 1200),
            confidence: entry.evaluation?.confidence || null,
          },
          input,
        };
      });
  });

  return [
    ...evaluatorSuggestions,
    ...collectAfterProcessAuditSuggestionsFromSession(session, appliedIds),
  ];
}

function collectAfterProcessAuditSuggestionsFromSession(session = {}, appliedIds = new Set()) {
  const getAuditEntriesFromSession = afterProcessAuditsController?._private?.getAuditEntriesFromSession;
  if (typeof getAuditEntriesFromSession !== 'function') {
    return [];
  }

  return getAuditEntriesFromSession(session)
    .filter((audit) => audit?.cleared !== true)
    .flatMap((audit = {}) => {
      const learningReview = audit.learningReview && typeof audit.learningReview === 'object'
        ? audit.learningReview
        : {};
      const explicitSuggestions = Array.isArray(learningReview.selfReflectionUpdateSuggestions)
        ? learningReview.selfReflectionUpdateSuggestions
        : [];

      return explicitSuggestions
        .filter((suggestion) => {
          return !suggestion?.toolId || suggestion.toolId === SELF_REFLECTION_UPDATE_TOOL_ID;
        })
        .map((suggestion, index) => {
          const input = normalizeAfterProcessAuditSuggestionInput(suggestion, audit);
          const id = buildAfterProcessAuditSuggestionId({ session, audit, suggestion: { ...suggestion, input }, index });
          const applied = appliedIds.has(id);
          return {
            id,
            status: applied ? 'applied' : normalizeInline(suggestion.status || 'suggested', 80),
            applied,
            canApply: !applied && input.actions.length > 0,
            toolId: SELF_REFLECTION_UPDATE_TOOL_ID,
            sourceType: 'after-process-audit',
            sessionId: session.id || audit.sessionId || '',
            messageId: '',
            feedbackId: audit.auditId || '',
            auditId: audit.auditId || '',
            sourceAudit: {
              auditId: audit.auditId || '',
              summary: normalizeInline(audit.summary || '', 500),
              toolFailureReview: audit.toolFailureReview || {},
              learningReview,
            },
            rating: '',
            reason: normalizeInline(audit.summary || '', 500),
            updatedAt: audit.completedAt || audit.updatedAt || session.updatedAt || '',
            evaluation: {
              lesson: normalizeInline(
                input.reflection
                  || (Array.isArray(learningReview.durableLessons) ? learningReview.durableLessons[0] : ''),
                1200,
              ),
              confidence: null,
            },
            input,
          };
        });
    });
}

class SelfReflectionUpdatesController {
  async list(req, res) {
    const data = readSelfReflectionUpdates({
      limit: req.query?.limit,
    });
    res.json({
      success: true,
      data,
    });
  }

  getSessionStore(req = {}) {
    return req.app?.locals?.sessionStore || defaultSessionStore;
  }

  async collectSuggestions(req = {}, options = {}) {
    const limit = parseLimit(options.limit ?? req.query?.limit, DEFAULT_SUGGESTION_LIMIT, 100);
    const sessionLimit = parseLimit(
      options.sessionLimit ?? req.query?.sessionLimit,
      DEFAULT_SESSION_SCAN_LIMIT,
      500,
    );
    const store = this.getSessionStore(req);
    const sessions = typeof store?.list === 'function'
      ? await store.list({ limit: sessionLimit })
      : [];
    const appliedIds = extractAppliedSuggestionIds();
    const suggestions = (Array.isArray(sessions) ? sessions : [])
      .flatMap((session) => collectSuggestionsFromSession(session, appliedIds))
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());

    return {
      suggestions: suggestions.slice(0, limit),
      meta: {
        limit,
        sessionLimit,
        count: suggestions.length,
        returned: Math.min(limit, suggestions.length),
      },
    };
  }

  async listSuggestions(req, res, next) {
    try {
      const data = await this.collectSuggestions(req);
      res.json({
        success: true,
        data,
      });
    } catch (error) {
      if (next) {
        next(error);
        return;
      }
      throw error;
    }
  }

  async applySuggestion(req, res, next) {
    try {
      const id = String(req.params?.id || '').trim();
      if (!id) {
        return res.status(400).json({ success: false, error: 'Suggestion id is required.' });
      }

      const data = await this.collectSuggestions(req, { limit: 500, sessionLimit: 500 });
      const suggestion = data.suggestions.find((entry) => entry.id === id);
      if (!suggestion) {
        return res.status(404).json({ success: false, error: 'Self-reflection suggestion not found.' });
      }
      if (suggestion.applied) {
        return res.status(409).json({ success: false, error: 'Self-reflection suggestion has already been applied.' });
      }
      if (!suggestion.canApply) {
        return res.status(400).json({ success: false, error: 'Self-reflection suggestion has no applyable actions.' });
      }

      const result = applySelfReflectionUpdate({
        ...suggestion.input,
        source: normalizeInline(`${suggestion.input.source || 'alignment-evaluator'} approved`, 120),
        trigger: `${normalizeInline(suggestion.input.trigger || suggestion.reason || 'alignment feedback', 450)} [${APPLIED_SUGGESTION_MARKER}${id}]`,
        dryRun: false,
        apply: true,
      });
      let toolFailureHint = null;
      if (suggestion.sourceType === 'after-process-audit' && result?.applied === true) {
        toolFailureHint = buildApprovedAfterProcessToolFailureHint({
          sourceAudit: suggestion.sourceAudit || {
            auditId: suggestion.auditId || '',
            summary: suggestion.reason || '',
          },
          suggestion,
        });
        const store = this.getSessionStore(req);
        if (toolFailureHint && typeof store?.get === 'function' && typeof store?.update === 'function') {
          const sourceSession = await store.get(suggestion.sessionId);
          if (sourceSession) {
            await store.update(suggestion.sessionId, {
              metadata: {
                afterProcessAuditToolHints: mergeApprovedAfterProcessToolFailureHint(
                  sourceSession.metadata?.afterProcessAuditToolHints || [],
                  toolFailureHint,
                ),
              },
            });
          }
        }
      }

      res.json({
        success: true,
        data: {
          suggestion: {
            ...suggestion,
            status: 'applied',
            applied: true,
            canApply: false,
          },
          result,
          ...(toolFailureHint ? { toolFailureHint } : {}),
        },
      });
    } catch (error) {
      if (error.statusCode || error.status) {
        return res.status(error.statusCode || error.status).json({
          success: false,
          error: error.message,
        });
      }
      if (next) {
        next(error);
        return;
      }
      throw error;
    }
  }
}

module.exports = new SelfReflectionUpdatesController();

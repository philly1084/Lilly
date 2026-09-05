'use strict';

const { applySelfReflectionUpdate } = require('../self-reflection-updater');
const { candidateHash, compareTaskTrials } = require('../agent-evals/task-trials');
const { evaluateSuggestion: evaluateSandboxSuggestion } = require('./suggestion-trials');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SUGGESTIONS = 25;
const DEFAULT_SESSION_SCAN_LIMIT = 200;
const DEFAULT_LOG_LOOKBACK_HOURS = 24;
const DEFAULT_APPLY_LIMIT = 1;
const SAFE_AUTO_ACTION_TYPES = new Set([
  'model_card_note',
  'agent_notes_append',
  'carryover_notes_append',
]);

function normalizeText(value = '', limit = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Boolean(value);
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function getDayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function normalizeDailyAlignmentConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: normalizeBoolean(source.enabled, true),
    autoApply: normalizeBoolean(source.autoApply, true),
    intervalHours: normalizePositiveInteger(source.intervalHours, 24, { min: 1, max: 168 }),
    logLookbackHours: normalizePositiveInteger(source.logLookbackHours, DEFAULT_LOG_LOOKBACK_HOURS, { min: 1, max: 168 }),
    maxSuggestions: normalizePositiveInteger(source.maxSuggestions, DEFAULT_MAX_SUGGESTIONS, { min: 1, max: 100 }),
    sessionScanLimit: normalizePositiveInteger(source.sessionScanLimit, DEFAULT_SESSION_SCAN_LIMIT, { min: 1, max: 500 }),
    maxAppliedPerRun: normalizePositiveInteger(source.maxAppliedPerRun, DEFAULT_APPLY_LIMIT, { min: 1, max: 4 }),
  };
}

function getNextAt(now = new Date(), config = {}) {
  return new Date(now.getTime() + normalizePositiveInteger(config.intervalHours, 24) * 60 * 60 * 1000).toISOString();
}

function shouldRunDailyAlignment(previousState = {}, config = {}, now = new Date()) {
  const normalized = normalizeDailyAlignmentConfig(config);
  if (!normalized.enabled) {
    return false;
  }

  const dayKey = getDayKey(now);
  if (previousState.lastDayKey !== dayKey) {
    return true;
  }

  const nextAt = previousState.nextAt ? new Date(previousState.nextAt) : null;
  if (!nextAt || Number.isNaN(nextAt.getTime())) {
    return true;
  }

  return nextAt.getTime() <= now.getTime();
}

function summarizeLogs(logs = [], now = new Date(), lookbackHours = DEFAULT_LOG_LOOKBACK_HOURS) {
  const cutoff = now.getTime() - lookbackHours * 60 * 60 * 1000;
  const recent = (Array.isArray(logs) ? logs : [])
    .filter((entry) => {
      const timestamp = entry?.timestamp ? new Date(entry.timestamp).getTime() : 0;
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });

  const byLevel = {};
  const byStatus = {};
  const models = new Set();
  const errorSamples = [];

  recent.forEach((entry) => {
    const level = normalizeText(entry.level || 'unknown', 80) || 'unknown';
    const status = normalizeText(entry.status || 'unknown', 80) || 'unknown';
    byLevel[level] = (byLevel[level] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (entry.model) {
      models.add(normalizeText(entry.model, 120));
    }
    if (errorSamples.length < 3 && (level === 'error' || status === 'error' || entry.error)) {
      errorSamples.push(normalizeText(entry.error || entry.message || 'error', 220));
    }
  });

  return {
    count: recent.length,
    byLevel,
    byStatus,
    models: Array.from(models).filter(Boolean).slice(0, 8),
    errorSamples,
  };
}

function summarizeSuggestions(suggestions = []) {
  const sourceTypes = {};
  let canApply = 0;
  (Array.isArray(suggestions) ? suggestions : []).forEach((suggestion) => {
    const sourceType = normalizeText(suggestion.sourceType || suggestion.input?.source || 'alignment-feedback', 120);
    sourceTypes[sourceType] = (sourceTypes[sourceType] || 0) + 1;
    if (suggestion.canApply && !suggestion.applied) {
      canApply += 1;
    }
  });

  return {
    count: Array.isArray(suggestions) ? suggestions.length : 0,
    canApply,
    sourceTypes,
  };
}

function isSafeAutoSuggestion(suggestion = {}) {
  if (!suggestion?.canApply || suggestion.applied) {
    return false;
  }
  const actions = Array.isArray(suggestion.input?.actions) ? suggestion.input.actions : [];
  return actions.length > 0 && actions.every((action) => {
    const type = String(action?.type || action?.action || action?.kind || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return SAFE_AUTO_ACTION_TYPES.has(type);
  });
}

function scoreSuggestion(suggestion = {}) {
  const actions = Array.isArray(suggestion.input?.actions) ? suggestion.input.actions : [];
  const typeScore = actions.reduce((score, action) => {
    const type = String(action?.type || action?.action || action?.kind || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (type === 'model_card_note') return Math.max(score, 5);
    if (type === 'agent_notes_append' || type === 'carryover_notes_append') return Math.max(score, 4);
    return score;
  }, 0);
  const sourceBonus = suggestion.sourceType === 'after-process-audit' ? 2 : 1;
  const ratingBonus = suggestion.rating === 'down' ? 2 : 0;
  const updatedAt = suggestion.updatedAt ? new Date(suggestion.updatedAt).getTime() : 0;
  const recencyBonus = Number.isFinite(updatedAt) ? Math.min(1, updatedAt / 1e15) : 0;
  return typeScore + sourceBonus + ratingBonus + recencyBonus;
}

async function defaultCollectSuggestions({ sessionStore, limit, sessionLimit } = {}) {
  const controller = require('../routes/admin/self-reflection-updates.controller');
  return controller.collectSuggestions({
    app: {
      locals: {
        sessionStore,
      },
    },
    query: {},
  }, {
    limit,
    sessionLimit,
  });
}

function buildHeartbeatEvidence(heartbeat = {}) {
  return {
    status: normalizeText(heartbeat.status || '', 80),
    lastAt: heartbeat.lastAt || null,
    nextAt: heartbeat.nextAt || null,
    reason: normalizeText(heartbeat.reason || '', 160),
    createdWorkloads: Number.isFinite(Number(heartbeat.createdWorkloads)) ? Number(heartbeat.createdWorkloads) : 0,
    skipped: Number.isFinite(Number(heartbeat.skipped)) ? Number(heartbeat.skipped) : 0,
  };
}

async function runDailyFeedbackAlignment({
  config = {},
  previousState = {},
  heartbeat = {},
  logs = [],
  sessionStore = null,
  collectSuggestions = defaultCollectSuggestions,
  applyUpdate = applySelfReflectionUpdate,
  evaluateSuggestion = evaluateSandboxSuggestion,
  now = new Date(),
  force = false,
  reason = 'timer',
} = {}) {
  const normalizedConfig = normalizeDailyAlignmentConfig(config);
  const dayKey = getDayKey(now);
  const nextAt = getNextAt(now, normalizedConfig);

  if (!normalizedConfig.enabled) {
    return {
      ...previousState,
      status: 'disabled',
      nextAt,
      updatedAt: now.toISOString(),
    };
  }

  if (!force && !shouldRunDailyAlignment(previousState, normalizedConfig, now)) {
    return {
      ...previousState,
      status: previousState.status || 'steady',
      skipped: true,
    };
  }

  let suggestions = [];
  let suggestionMeta = {};
  let collectionError = '';
  try {
    const collected = await collectSuggestions({
      sessionStore,
      limit: normalizedConfig.maxSuggestions,
      sessionLimit: normalizedConfig.sessionScanLimit,
    });
    suggestions = Array.isArray(collected?.suggestions) ? collected.suggestions : [];
    suggestionMeta = collected?.meta || {};
  } catch (error) {
    collectionError = normalizeText(error.message || String(error), 300);
  }

  const logSummary = summarizeLogs(logs, now, normalizedConfig.logLookbackHours);
  const suggestionSummary = summarizeSuggestions(suggestions);
  const candidates = suggestions
    .filter(isSafeAutoSuggestion)
    .sort((a, b) => scoreSuggestion(b) - scoreSuggestion(a))
    .slice(0, normalizedConfig.maxAppliedPerRun);

  const applied = [];
  const rejected = [];
  const evaluated = [];
  const appliedHashes = new Set(previousState.appliedHashes || []);

  if (normalizedConfig.autoApply && candidates.length > 0) {
    for (const suggestion of candidates) {
      try {
        const hash = candidateHash(suggestion.input.actions.map((entry) => ({
          type: entry.type || entry.action || entry.kind,
          content: String(entry.content || '').replace(/\s+/g, ' ').trim().toLowerCase(),
        })));
        if (appliedHashes.has(hash)) {
          rejected.push({ id: suggestion.id, reason: 'duplicate_lesson' });
          continue;
        }
        // The runtime evaluator executes isolated baseline/candidate trials. Model-provided
        // confidence and self-reported scores are never accepted as promotion evidence.
        const trials = typeof evaluateSuggestion === 'function'
          ? await evaluateSuggestion(suggestion) : null;
        const gate = compareTaskTrials(trials?.baseline, trials?.candidate, suggestion.input.actions);
        evaluated.push({ id: suggestion.id, hash, ...gate });
        if (!gate.passed) {
          rejected.push({ id: suggestion.id, reason: gate.reason });
          continue;
        }
        const result = applyUpdate({
          ...suggestion.input,
          source: normalizeText(`${suggestion.input?.source || 'alignment-evaluator'} daily-alignment`, 120),
          trigger: `${normalizeText(suggestion.input?.trigger || suggestion.reason || 'alignment feedback', 450)} [daily-alignment:${dayKey}:${suggestion.id}]`,
          dryRun: false,
          apply: true,
        });
        applied.push({
          id: suggestion.id,
          sourceType: suggestion.sourceType || suggestion.input?.source || 'alignment-feedback',
          actionTypes: (suggestion.input?.actions || []).map((action) => normalizeText(action.type || action.action || action.kind || '', 80)).filter(Boolean),
          resultId: result.id,
          applied: result.applied === true,
        });
        if (result.applied === true) appliedHashes.add(hash);
      } catch (error) {
        rejected.push({
          id: suggestion.id,
          reason: normalizeText(error.message || String(error), 300),
        });
      }
    }
  }

  return {
    status: collectionError
      ? 'collection_error'
      : (applied.length > 0 ? 'applied' : (candidates.length > 0 ? 'validated' : 'steady')),
    lastAt: now.toISOString(),
    nextAt,
    lastDayKey: dayKey,
    reason: normalizeText(reason, 120),
    autoApply: normalizedConfig.autoApply,
    applied,
    rejected,
    evaluated,
    appliedHashes: Array.from(appliedHashes).slice(-200),
    evidence: {
      heartbeat: buildHeartbeatEvidence(heartbeat),
      logs: logSummary,
      suggestions: {
        ...suggestionSummary,
        meta: suggestionMeta,
        safeCandidates: candidates.length,
      },
      collectionError,
    },
  };
}

module.exports = {
  SAFE_AUTO_ACTION_TYPES,
  getDayKey,
  normalizeDailyAlignmentConfig,
  runDailyFeedbackAlignment,
  shouldRunDailyAlignment,
  summarizeLogs,
};

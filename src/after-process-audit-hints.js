const crypto = require('crypto');

const APPROVED_HINT_LIMIT = 20;
const DEFAULT_HINT_TTL_DAYS = 45;
const MIN_KEYWORD_OVERLAP = 2;
const ALLOWED_BOOLEAN_ORCHESTRATION_FLAGS = new Set([
  'afterProcessAuditEnabled',
  'agentDirectedRuntime',
  'neuralWaveResearchMode',
  'asyncRuntimeEnabled',
  'asyncRuntimeWebChatParallel',
  'asyncRuntimeAllowLiveRemote',
  'enableAlignmentEvaluator',
  'applyAlignmentGuidance',
]);

const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'based',
  'because',
  'before',
  'being',
  'between',
  'could',
  'done',
  'from',
  'have',
  'into',
  'like',
  'make',
  'need',
  'needs',
  'right',
  'should',
  'that',
  'the',
  'their',
  'then',
  'there',
  'this',
  'through',
  'tool',
  'tools',
  'using',
  'when',
  'where',
  'with',
  'work',
  'would',
]);

function normalizeInline(value = '', limit = 1000) {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value || '');
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return null;
}

function buildStableId(prefix, source = {}) {
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify(source))
    .digest('hex')
    .slice(0, 14);
  return `${prefix}-${hash}`;
}

function extractKeywords(text = '', limit = 18) {
  const tokens = String(text || '')
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{2,}/g) || [];
  return Array.from(new Set(tokens
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))))
    .slice(0, limit);
}

function collectAuditHintText({ sourceAudit = {}, recommendation = {} } = {}) {
  const toolSkillReview = sourceAudit.toolSkillReview || {};
  const learningReview = sourceAudit.learningReview || {};
  return [
    sourceAudit.summary,
    recommendation.reason,
    ...(Array.isArray(toolSkillReview.selectedSkills) ? toolSkillReview.selectedSkills : []),
    ...(Array.isArray(toolSkillReview.actualTools) ? toolSkillReview.actualTools : []),
    ...(Array.isArray(toolSkillReview.missingTools) ? toolSkillReview.missingTools : []),
    ...(Array.isArray(toolSkillReview.skillUpdates) ? toolSkillReview.skillUpdates : []),
    ...(Array.isArray(toolSkillReview.toolPolicyUpdates) ? toolSkillReview.toolPolicyUpdates : []),
    ...(Array.isArray(learningReview.durableLessons) ? learningReview.durableLessons : []),
    ...(Array.isArray(learningReview.outputQualityRisks) ? learningReview.outputQualityRisks : []),
  ].filter(Boolean).join(' ');
}

function normalizeApprovedAfterProcessHint(hint = {}) {
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) {
    return null;
  }
  const flag = normalizeInline(hint.flag || '', 120);
  const suggestedValue = normalizeBoolean(hint.suggestedValue);
  const currentValue = normalizeBoolean(hint.currentValue);
  if (!ALLOWED_BOOLEAN_ORCHESTRATION_FLAGS.has(flag) || suggestedValue === null) {
    return null;
  }
  const matchText = normalizeInline(hint.matchText || hint.reason || '', 900);
  const keywords = Array.isArray(hint.keywords)
    ? hint.keywords.map((entry) => normalizeInline(entry, 80)).filter(Boolean).slice(0, 18)
    : extractKeywords(matchText);
  const approvedAt = hint.approvedAt || new Date().toISOString();
  const expiresAt = hint.expiresAt || new Date(Date.now() + DEFAULT_HINT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: normalizeInline(hint.id || buildStableId('aph', {
      flag,
      suggestedValue,
      matchText,
      approvedAt,
    }), 120),
    auditId: normalizeInline(hint.auditId || '', 120),
    recommendationId: normalizeInline(hint.recommendationId || hint.sourceRecommendationId || '', 120),
    flag,
    currentValue,
    suggestedValue,
    reason: normalizeInline(hint.reason || '', 400),
    confidence: hint.confidence ?? null,
    matchText,
    keywords,
    status: hint.status === 'cleared' ? 'cleared' : 'active',
    approvedAt,
    expiresAt,
    useCount: Math.max(0, Number(hint.useCount) || 0),
  };
}

function buildApprovedAfterProcessHint({ sourceAudit = {}, recommendation = {} } = {}) {
  const matchText = collectAuditHintText({ sourceAudit, recommendation });
  return normalizeApprovedAfterProcessHint({
    id: buildStableId('aph', {
      auditId: sourceAudit.auditId || '',
      recommendationId: recommendation.id || '',
      flag: recommendation.flag || '',
      suggestedValue: recommendation.suggestedValue,
      reason: recommendation.reason || '',
    }),
    auditId: sourceAudit.auditId || '',
    recommendationId: recommendation.id || '',
    flag: recommendation.flag,
    currentValue: recommendation.currentValue,
    suggestedValue: recommendation.suggestedValue,
    reason: recommendation.reason || '',
    confidence: recommendation.confidence ?? null,
    matchText,
    keywords: extractKeywords(matchText),
  });
}

function normalizeApprovedAfterProcessHints(hints = []) {
  return (Array.isArray(hints) ? hints : [])
    .map((hint) => normalizeApprovedAfterProcessHint(hint))
    .filter(Boolean)
    .slice(-APPROVED_HINT_LIMIT);
}

function mergeApprovedAfterProcessHint(existingHints = [], hint = null) {
  const normalizedHint = normalizeApprovedAfterProcessHint(hint);
  if (!normalizedHint) {
    return normalizeApprovedAfterProcessHints(existingHints);
  }
  const hints = normalizeApprovedAfterProcessHints(existingHints)
    .filter((entry) => entry.id !== normalizedHint.id);
  return [...hints, normalizedHint].slice(-APPROVED_HINT_LIMIT);
}

function scoreHintMatch(hint = {}, text = '') {
  const normalizedHint = normalizeApprovedAfterProcessHint(hint);
  if (!normalizedHint || normalizedHint.status !== 'active') {
    return 0;
  }
  if (normalizedHint.expiresAt && new Date(normalizedHint.expiresAt).getTime() < Date.now()) {
    return 0;
  }
  const requestKeywords = new Set(extractKeywords(text, 28));
  if (requestKeywords.size === 0 || normalizedHint.keywords.length === 0) {
    return 0;
  }
  const overlap = normalizedHint.keywords.filter((keyword) => requestKeywords.has(keyword));
  const directMention = normalizedHint.keywords.some((keyword) => {
    return keyword.length >= 5 && String(text || '').toLowerCase().includes(keyword);
  });
  if (overlap.length < MIN_KEYWORD_OVERLAP && !directMention) {
    return 0;
  }
  return Math.min(1, (overlap.length / Math.max(MIN_KEYWORD_OVERLAP, normalizedHint.keywords.length)) + (directMention ? 0.15 : 0));
}

function resolveChatTimeAfterProcessAuditHints({
  session = {},
  text = '',
  orchestrationConfig = {},
} = {}) {
  const hints = normalizeApprovedAfterProcessHints(session?.metadata?.afterProcessAuditHints || []);
  const matchedHints = hints
    .map((hint) => ({
      hint,
      score: scoreHintMatch(hint, text),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  const overrides = {};
  const appliedHints = [];

  matchedHints.forEach(({ hint, score }) => {
    const actualCurrent = normalizeBoolean(orchestrationConfig?.[hint.flag]);
    if (actualCurrent !== null && hint.currentValue !== null && actualCurrent !== hint.currentValue) {
      return;
    }
    overrides[hint.flag] = hint.suggestedValue;
    appliedHints.push({
      id: hint.id,
      auditId: hint.auditId,
      recommendationId: hint.recommendationId,
      flag: hint.flag,
      suggestedValue: hint.suggestedValue,
      reason: hint.reason,
      score,
    });
  });

  return {
    hints,
    matchedHints: appliedHints,
    overrides,
    hasOverrides: Object.keys(overrides).length > 0,
  };
}

function buildClearedAuditIds(existingIds = [], auditId = '') {
  const normalizedAuditId = normalizeInline(auditId, 120);
  return Array.from(new Set([
    ...(Array.isArray(existingIds) ? existingIds : []).map((entry) => normalizeInline(entry, 120)).filter(Boolean),
    ...(normalizedAuditId ? [normalizedAuditId] : []),
  ])).slice(-200);
}

module.exports = {
  ALLOWED_BOOLEAN_ORCHESTRATION_FLAGS,
  APPROVED_HINT_LIMIT,
  buildApprovedAfterProcessHint,
  buildClearedAuditIds,
  buildStableId,
  mergeApprovedAfterProcessHint,
  normalizeApprovedAfterProcessHint,
  normalizeApprovedAfterProcessHints,
  normalizeBoolean,
  resolveChatTimeAfterProcessAuditHints,
  scoreHintMatch,
};

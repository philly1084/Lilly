const crypto = require('crypto');
const { sessionStore: defaultSessionStore } = require('../../session-store');
const settingsController = require('./settings.controller');

const DEFAULT_AUDIT_LIMIT = 20;
const DEFAULT_SESSION_SCAN_LIMIT = 100;
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

function parseLimit(value, fallback = DEFAULT_AUDIT_LIMIT, max = 200) {
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

function getAuditEntriesFromSession(session = {}) {
  const metadata = session?.metadata || {};
  const current = metadata.afterProcessAudit && typeof metadata.afterProcessAudit === 'object'
    ? [metadata.afterProcessAudit]
    : [];
  const history = Array.isArray(metadata.afterProcessAuditHistory)
    ? metadata.afterProcessAuditHistory
    : [];
  const seen = new Set();

  return [...history, ...current]
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => {
      const key = `${entry.auditId || ''}:${entry.completedAt || ''}:${entry.model || ''}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((entry) => normalizeAuditEntry(session, entry));
}

function normalizeFlagRecommendation(recommendation = {}, audit = {}, index = 0) {
  const flag = normalizeInline(recommendation.flag || recommendation.name || '', 120);
  const currentValue = normalizeBoolean(recommendation.currentValue);
  const suggestedValue = normalizeBoolean(recommendation.suggestedValue);
  const canApply = ALLOWED_BOOLEAN_ORCHESTRATION_FLAGS.has(flag)
    && currentValue !== null
    && suggestedValue !== null
    && currentValue !== suggestedValue;
  return {
    id: buildStableId('afr', {
      auditId: audit.auditId || '',
      flag,
      index,
      suggestedValue,
      reason: recommendation.reason || '',
    }),
    flag,
    currentValue,
    suggestedValue,
    reason: normalizeInline(recommendation.reason || '', 400),
    confidence: recommendation.confidence ?? null,
    canApply,
    status: canApply ? 'suggested' : 'review_only',
  };
}

function normalizeAuditEntry(session = {}, entry = {}) {
  const audit = entry.audit && typeof entry.audit === 'object' ? entry.audit : {};
  const recommendationSource = Array.isArray(audit.recommendedFlagChanges)
    ? audit.recommendedFlagChanges
    : [];
  const auditId = normalizeInline(entry.auditId || '', 120) || buildStableId('after-audit', {
    sessionId: session.id || '',
    completedAt: entry.completedAt || '',
    summary: audit.summary || '',
  });

  return {
    auditId,
    sessionId: session.id || '',
    status: normalizeInline(entry.status || 'completed', 80),
    model: normalizeInline(entry.model || '', 120),
    completedAt: entry.completedAt || session.updatedAt || '',
    updatedAt: session.updatedAt || entry.completedAt || '',
    decision: normalizeInline(audit.auditDecision || 'watch', 80),
    qualityScore: Number.isFinite(Number(audit.qualityScore)) ? Number(audit.qualityScore) : null,
    summary: normalizeInline(audit.summary || '', 500),
    orchestrationReview: audit.orchestrationReview || {},
    toolSkillReview: audit.toolSkillReview || {},
    learningReview: audit.learningReview || {},
    recommendedFlagChanges: recommendationSource
      .map((recommendation, index) => normalizeFlagRecommendation(recommendation, { auditId }, index))
      .filter((recommendation) => recommendation.flag),
    followUpActions: Array.isArray(audit.followUpActions) ? audit.followUpActions : [],
  };
}

class AfterProcessAuditsController {
  getSessionStore(req = {}) {
    return req.app?.locals?.sessionStore || defaultSessionStore;
  }

  async collectAudits(req = {}, options = {}) {
    const limit = parseLimit(options.limit ?? req.query?.limit, DEFAULT_AUDIT_LIMIT, 100);
    const sessionLimit = parseLimit(
      options.sessionLimit ?? req.query?.sessionLimit,
      DEFAULT_SESSION_SCAN_LIMIT,
      500,
    );
    const decision = normalizeInline(options.decision ?? req.query?.decision ?? '', 80);
    const store = this.getSessionStore(req);
    const sessions = typeof store?.list === 'function'
      ? await store.list({ limit: sessionLimit })
      : [];
    let audits = (Array.isArray(sessions) ? sessions : [])
      .flatMap((session) => getAuditEntriesFromSession(session))
      .sort((a, b) => new Date(b.completedAt || b.updatedAt || 0).getTime() - new Date(a.completedAt || a.updatedAt || 0).getTime());

    if (decision) {
      audits = audits.filter((audit) => audit.decision === decision);
    }

    const recommendationCount = audits.reduce((count, audit) => {
      return count + audit.recommendedFlagChanges.filter((recommendation) => recommendation.canApply).length;
    }, 0);
    const needsFollowupCount = audits.filter((audit) => audit.decision === 'needs_followup').length;

    return {
      audits: audits.slice(0, limit),
      meta: {
        limit,
        sessionLimit,
        count: audits.length,
        returned: Math.min(limit, audits.length),
        needsFollowupCount,
        recommendationCount,
      },
    };
  }

  async list(req, res, next) {
    try {
      res.json({
        success: true,
        data: await this.collectAudits(req),
      });
    } catch (error) {
      next(error);
    }
  }

  async applyFlagRecommendation(req, res, next) {
    try {
      const recommendationId = normalizeInline(req.params?.id || req.body?.id || '', 120);
      if (!recommendationId) {
        return res.status(400).json({ success: false, error: 'recommendation id is required' });
      }

      const data = await this.collectAudits(req, {
        limit: 100,
        sessionLimit: parseLimit(req.body?.sessionLimit ?? req.query?.sessionLimit, DEFAULT_SESSION_SCAN_LIMIT, 500),
      });
      const sourceAudit = data.audits.find((audit) => {
        return audit.recommendedFlagChanges.some((recommendation) => recommendation.id === recommendationId);
      });
      const recommendation = sourceAudit?.recommendedFlagChanges
        .find((entry) => entry.id === recommendationId);
      if (!sourceAudit || !recommendation) {
        return res.status(404).json({ success: false, error: 'recommendation not found' });
      }
      if (!recommendation.canApply || !ALLOWED_BOOLEAN_ORCHESTRATION_FLAGS.has(recommendation.flag)) {
        return res.status(400).json({ success: false, error: 'recommendation cannot be applied automatically' });
      }

      const current = settingsController.getEffectiveOrchestrationConfig();
      const actualCurrentValue = normalizeBoolean(current[recommendation.flag]);
      if (actualCurrentValue !== recommendation.currentValue) {
        return res.status(409).json({
          success: false,
          error: 'orchestration flag changed since audit recommendation was created',
          data: {
            flag: recommendation.flag,
            expectedCurrentValue: recommendation.currentValue,
            actualCurrentValue,
          },
        });
      }

      settingsController.settings = settingsController.deepMerge(settingsController.settings, {
        orchestration: settingsController.normalizeOrchestrationSettings({
          ...(settingsController.settings?.orchestration || {}),
          [recommendation.flag]: recommendation.suggestedValue,
        }),
      });
      await settingsController.saveSettings();
      await settingsController.applyAsyncRuntimeSettingsToRuntime(req);

      const publicSettings = settingsController.getPublicSettings();
      return res.json({
        success: true,
        data: {
          recommendation: {
            ...recommendation,
            status: 'applied',
            applied: true,
            appliedAt: new Date().toISOString(),
          },
          auditId: sourceAudit.auditId,
          sessionId: sourceAudit.sessionId,
          settings: publicSettings,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AfterProcessAuditsController();
module.exports._private = {
  ALLOWED_BOOLEAN_ORCHESTRATION_FLAGS,
  getAuditEntriesFromSession,
  normalizeAuditEntry,
  normalizeFlagRecommendation,
};

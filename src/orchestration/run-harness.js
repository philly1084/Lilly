class HarnessState {
  constructor({
    runId = '',
    workflowName = 'KimiBuilt harness run',
    groupId = '',
    mode = 'respond',
    maxRounds = 1,
    maxToolCalls = 4,
    blockers = [],
    evidence = [],
    toolEvents = [],
  } = {}) {
    this.type = 'HarnessState';
    this.runId = runId;
    this.workflowName = workflowName || 'KimiBuilt harness run';
    this.groupId = groupId || runId || '';
    this.mode = mode;
    this.maxRounds = maxRounds;
    this.maxToolCalls = maxToolCalls;
    this.blockers = Array.isArray(blockers) ? blockers : [];
    this.evidence = Array.isArray(evidence)
      ? evidence.map((entry, index) => this.normalizeEvidence(entry, index)).filter(Boolean)
      : [];
    this.toolEvents = Array.isArray(toolEvents) ? toolEvents : [];
  }

  addToolEvent(event = {}) {
    this.toolEvents.push({
      type: 'ToolExecutionEvent',
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    });
  }

  addBlocker(blocker = {}) {
    this.blockers.push({
      type: 'Blocker',
      ...blocker,
      timestamp: blocker.timestamp || new Date().toISOString(),
    });
  }

  normalizeEvidence(evidence = {}, index = this.evidence.length) {
    if (!evidence || typeof evidence !== 'object') {
      return null;
    }

    const summary = String(evidence.summary || evidence.description || evidence.name || '').trim();
    if (!summary) {
      return null;
    }

    return {
      type: 'HarnessEvidence',
      id: evidence.id || `evidence-${index + 1}`,
      summary,
      source: evidence.source || evidence.tool || evidence.url || null,
      score: Number.isFinite(Number(evidence.score)) ? Number(evidence.score) : null,
      passed: typeof evidence.passed === 'boolean' ? evidence.passed : null,
      metadata: evidence.metadata && typeof evidence.metadata === 'object' ? evidence.metadata : {},
      timestamp: evidence.timestamp || new Date().toISOString(),
    };
  }

  addEvidence(evidence = {}) {
    const normalized = this.normalizeEvidence(evidence);
    if (!normalized) {
      return null;
    }
    this.evidence.push(normalized);
    return normalized;
  }

  getDiagnostics() {
    const failedEvidence = this.evidence.filter((entry) => entry.passed === false);
    const scoredEvidence = this.evidence.filter((entry) => (
      entry.score !== null && entry.score !== undefined && Number.isFinite(Number(entry.score))
    ));
    const sourcedEvidence = this.evidence.filter((entry) => Boolean(entry.source));
    const verifiedEvidence = this.evidence.filter((entry) => (
      entry.passed === true
      || entry.metadata?.verified === true
      || entry.metadata?.verification?.ok === true
    ));
    const staleEvidence = this.evidence.filter((entry) => (
      entry.metadata?.stale === true
      || entry.metadata?.status === 'stale'
      || entry.metadata?.verification?.stale === true
    ));
    const failedToolEvents = this.toolEvents.filter((event = {}) => {
      const status = String(event.status || event.outcome || '').toLowerCase();
      return ['blocked', 'error', 'failed', 'timeout'].includes(status);
    });
    const retryCount = this.toolEvents.reduce((total, event = {}) => {
      const retries = Number(event.retryCount ?? event.retries ?? 0);
      return total + (Number.isFinite(retries) ? retries : 0);
    }, 0);
    const tokenCount = this.toolEvents.reduce((total, event = {}) => {
      const usage = event.usage || event.tokenUsage || event.metadata?.usage || event.metadata?.tokenUsage || {};
      const tokens = Number(
        usage.total_tokens
          ?? usage.totalTokens
          ?? usage.tokens
          ?? event.tokens
          ?? event.metadata?.tokens
          ?? 0,
      );
      return total + (Number.isFinite(tokens) ? tokens : 0);
    }, 0);

    let outcome = 'passed';
    let failureCategory = null;
    if (this.blockers.length > 0) {
      outcome = 'blocked';
      failureCategory = 'blocker';
    } else if (failedToolEvents.length > 0) {
      outcome = 'failed';
      failureCategory = 'tool-event';
    } else if (failedEvidence.length > 0) {
      outcome = 'failed';
      failureCategory = 'evidence';
    }

    return {
      outcome,
      failureCategory,
      blockerCount: this.blockers.length,
      evidenceCount: this.evidence.length,
      failedEvidenceCount: failedEvidence.length,
      failedToolEventCount: failedToolEvents.length,
      evidenceQuality: {
        sourcedCount: sourcedEvidence.length,
        unsourcedCount: this.evidence.length - sourcedEvidence.length,
        verifiedCount: verifiedEvidence.length,
        staleCount: staleEvidence.length,
        sourceCoverage: this.evidence.length > 0 ? sourcedEvidence.length / this.evidence.length : 0,
        averageScore: scoredEvidence.length > 0
          ? scoredEvidence.reduce((total, entry) => total + Number(entry.score), 0) / scoredEvidence.length
          : null,
      },
      failedStepTypes: [...new Set(failedToolEvents.map((event = {}) => (
        event.stepType || event.toolType || event.name || event.type || 'tool-event'
      )))],
      retryCount,
      tokenCount,
    };
  }

  toTraceMetadata() {
    return {
      workflowName: this.workflowName,
      groupId: this.groupId,
      runId: this.runId,
      mode: this.mode,
      evidenceCount: this.evidence.length,
      blockerCount: this.blockers.length,
      toolEventCount: this.toolEvents.length,
      diagnostics: this.getDiagnostics(),
    };
  }

  toGradingPayload({
    item = {},
    outputText = '',
    outputTools = [],
    outputJson = null,
    referenceAnswer = '',
    choices = [],
  } = {}) {
    const normalizedItem = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const normalizedOutputTools = Array.isArray(outputTools) && outputTools.length > 0
      ? outputTools
      : this.deriveOutputToolsFromEvents();
    const sample = {
      output_text: String(outputText || ''),
      output_tools: normalizedOutputTools,
      choices: Array.isArray(choices) ? choices : [],
    };

    if (outputJson && typeof outputJson === 'object' && !Array.isArray(outputJson)) {
      sample.output_json = outputJson;
    }

    return {
      item: {
        ...normalizedItem,
        reference_answer: normalizedItem.reference_answer || referenceAnswer || '',
      },
      sample,
      evidence: this.evidence,
      blockers: this.blockers,
      metadata: this.toTraceMetadata(),
    };
  }

  deriveOutputToolsFromEvents() {
    return this.toolEvents
      .filter((event = {}) => {
        const type = String(event.type || event.stepType || event.toolType || '').toLowerCase();
        return (
          type.includes('tool')
          || Boolean(event.toolName)
          || Boolean(event.functionName)
          || Boolean(event.arguments)
          || Boolean(event.args)
          || Boolean(event.metadata?.toolCall)
        );
      })
      .map((event = {}) => {
        const toolCall = event.metadata?.toolCall && typeof event.metadata.toolCall === 'object'
          ? event.metadata.toolCall
          : {};

        return {
          name: event.toolName || event.functionName || toolCall.name || event.name || 'tool-call',
          arguments: event.arguments || event.args || event.input || toolCall.arguments || {},
          status: event.status || event.outcome || toolCall.status || null,
          output: event.output || event.result || toolCall.output || null,
        };
      });
  }

  toJSON() {
    return {
      type: this.type,
      runId: this.runId,
      workflowName: this.workflowName,
      groupId: this.groupId,
      mode: this.mode,
      maxRounds: this.maxRounds,
      maxToolCalls: this.maxToolCalls,
      blockers: this.blockers,
      evidence: this.evidence,
      toolEvents: this.toolEvents,
      traceMetadata: this.toTraceMetadata(),
    };
  }
}

module.exports = {
  HarnessState,
};

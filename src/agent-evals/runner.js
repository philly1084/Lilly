'use strict';

const { AGENT_EVAL_CASES } = require('./corpus');
const {
  createEvidenceAttestation,
  normalizeEvidenceAttestation,
} = require('../agent-evidence');
const { issueApprovalReceipt, normalizeApprovalReceipt } = require('../tool-invocation');

const EVAL_RUN_VERSION = 'EvalRun/v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeEvidence(result = {}) {
  return asArray(result.evidenceAttestations || result.evidence)
    .map(normalizeEvidenceAttestation)
    .filter(Boolean)
    .map((entry) => ({
      kind: normalizeText(entry.kind),
      verdict: normalizeText(entry.verdict).toLowerCase(),
    }));
}

function hasPassingEvidence(evidence = [], kind = '') {
  return evidence.some((entry) => entry.kind === kind && ['pass', 'passed', 'observed', 'verified'].includes(entry.verdict));
}

function validateCase(evalCase = {}, result = {}) {
  const failures = [];
  const validators = new Set(asArray(evalCase.validators));
  const tools = asArray(result.tools || result.toolIds).map(normalizeText).filter(Boolean);
  const signals = asArray(result.signals || result.failureTags).map(normalizeText).filter(Boolean);
  const evidence = normalizeEvidence(result);
  const route = normalizeText(result.route || result.executionProfile || result.mode);
  const status = normalizeText(result.status || result.completionStatus).toLowerCase();
  const approvals = asArray(result.approvals || result.approvalReceipts);

  if (validators.has('route') && evalCase.expectedRoute && route !== evalCase.expectedRoute) {
    failures.push({ validator: 'route', expected: evalCase.expectedRoute, actual: route || '(missing)' });
  }

  if (validators.has('tools')) {
    asArray(evalCase.expectedTools).forEach((toolId) => {
      if (!tools.includes(toolId)) {
        failures.push({ validator: 'tools', expected: toolId, actual: tools });
      }
    });
    asArray(evalCase.forbiddenTools).forEach((toolId) => {
      if (tools.includes(toolId)) {
        failures.push({ validator: 'forbidden-tool', actual: toolId });
      }
    });
  }

  if (validators.has('forbidden-signals')) {
    asArray(evalCase.forbiddenSignals).forEach((signal) => {
      if (signals.includes(signal)) {
        failures.push({ validator: 'forbidden-signal', actual: signal });
      }
    });
  }

  if (validators.has('evidence')) {
    asArray(evalCase.requiredEvidenceKinds).forEach((kind) => {
      if (!hasPassingEvidence(evidence, kind)) {
        failures.push({ validator: 'evidence', expected: kind });
      }
    });
  }

  if (validators.has('completion') && !['complete', 'completed', 'passed'].includes(status)) {
    failures.push({ validator: 'completion', expected: 'completed', actual: status || '(missing)' });
  }

  if (validators.has('isolation') && result.isolationMaintained !== true) {
    failures.push({ validator: 'isolation', expected: true, actual: result.isolationMaintained });
  }

  if (validators.has('approval') && !approvals.some((approval) => normalizeApprovalReceipt(approval))) {
    failures.push({ validator: 'approval', expected: 'scoped approved receipt' });
  }

  if (validators.has('no-approval') && approvals.length > 0) {
    failures.push({ validator: 'no-approval', expected: 0, actual: approvals.length });
  }

  const rawCostUsd = result.costUsd ?? result.usage?.costUsd;
  const costUsd = Number(rawCostUsd);
  if (Number.isFinite(Number(evalCase.maxCostUsd)) && !Number.isFinite(costUsd)) {
    failures.push({ validator: 'cost', expected: 'recorded cost', actual: '(missing)' });
  } else if (Number.isFinite(Number(evalCase.maxCostUsd)) && costUsd > Number(evalCase.maxCostUsd)) {
    failures.push({ validator: 'cost', expected: `<=${evalCase.maxCostUsd}`, actual: costUsd });
  }

  const rawLatencyMs = result.latencyMs ?? result.durationMs;
  const latencyMs = Number(rawLatencyMs);
  if (Number.isFinite(Number(evalCase.maxLatencyMs)) && !Number.isFinite(latencyMs)) {
    failures.push({ validator: 'latency', expected: 'recorded latency', actual: '(missing)' });
  } else if (Number.isFinite(Number(evalCase.maxLatencyMs)) && latencyMs > Number(evalCase.maxLatencyMs)) {
    failures.push({ validator: 'latency', expected: `<=${evalCase.maxLatencyMs}`, actual: latencyMs });
  }

  return {
    caseId: evalCase.id,
    category: evalCase.category,
    critical: evalCase.critical === true,
    passed: failures.length === 0,
    failures,
    metrics: {
      costUsd: Number.isFinite(costUsd) ? costUsd : Number.NaN,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : Number.NaN,
      evidenceCoverage: asArray(evalCase.requiredEvidenceKinds).length === 0
        ? 1
        : asArray(evalCase.requiredEvidenceKinds).filter((kind) => hasPassingEvidence(evidence, kind)).length
          / asArray(evalCase.requiredEvidenceKinds).length,
      toolPrecision: tools.length === 0
        ? (asArray(evalCase.expectedTools).length === 0 ? 1 : 0)
        : tools.filter((toolId) => asArray(evalCase.expectedTools).includes(toolId)).length / tools.length,
    },
  };
}

function average(values = []) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function runEvalSuite({ cases = AGENT_EVAL_CASES, results = [], label = 'candidate' } = {}) {
  const resultById = new Map(asArray(results).map((result) => [result.caseId || result.id, result]));
  const caseResults = cases.map((evalCase) => validateCase(evalCase, resultById.get(evalCase.id) || {}));
  const passed = caseResults.filter((entry) => entry.passed).length;
  const criticalFailures = caseResults.filter((entry) => entry.critical && !entry.passed);

  return {
    schemaVersion: EVAL_RUN_VERSION,
    label,
    createdAt: new Date().toISOString(),
    total: caseResults.length,
    passed,
    failed: caseResults.length - passed,
    passRate: caseResults.length ? passed / caseResults.length : 0,
    criticalFailures: criticalFailures.map((entry) => entry.caseId),
    metrics: {
      completionRate: caseResults.length ? passed / caseResults.length : 0,
      evidenceCoverage: average(caseResults.map((entry) => entry.metrics.evidenceCoverage)),
      toolPrecision: average(caseResults.map((entry) => entry.metrics.toolPrecision)),
      averageCostUsd: average(caseResults.map((entry) => entry.metrics.costUsd)),
      averageLatencyMs: average(caseResults.map((entry) => entry.metrics.latencyMs)),
    },
    caseResults,
  };
}

function compareEvalRuns(baseline = {}, candidate = {}, thresholds = {}) {
  const completionDropLimit = Number(thresholds.completionDropLimit ?? 0.05);
  const evidenceDropLimit = Number(thresholds.evidenceDropLimit ?? 0.05);
  const costIncreaseLimit = Number(thresholds.costIncreaseLimit ?? 0.15);
  const latencyIncreaseLimit = Number(thresholds.latencyIncreaseLimit ?? 0.15);
  const deltas = {
    completionRate: Number(candidate.metrics?.completionRate || 0) - Number(baseline.metrics?.completionRate || 0),
    evidenceCoverage: Number(candidate.metrics?.evidenceCoverage || 0) - Number(baseline.metrics?.evidenceCoverage || 0),
    averageCostUsd: Number(candidate.metrics?.averageCostUsd || 0) - Number(baseline.metrics?.averageCostUsd || 0),
    averageLatencyMs: Number(candidate.metrics?.averageLatencyMs || 0) - Number(baseline.metrics?.averageLatencyMs || 0),
  };
  const relativeCostIncrease = Number(baseline.metrics?.averageCostUsd || 0) > 0
    ? deltas.averageCostUsd / baseline.metrics.averageCostUsd
    : 0;
  const relativeLatencyIncrease = Number(baseline.metrics?.averageLatencyMs || 0) > 0
    ? deltas.averageLatencyMs / baseline.metrics.averageLatencyMs
    : 0;
  const regressions = [];

  if (asArray(candidate.criticalFailures).length > 0) regressions.push('critical_failure');
  if (Number(candidate.passRate || 0) < 0.9) regressions.push('pass_rate_below_90_percent');
  if (deltas.completionRate < -completionDropLimit) regressions.push('completion_drop');
  if (deltas.evidenceCoverage < -evidenceDropLimit) regressions.push('evidence_drop');
  if (relativeCostIncrease > costIncreaseLimit) regressions.push('cost_increase');
  if (relativeLatencyIncrease > latencyIncreaseLimit) regressions.push('latency_increase');

  return {
    passed: regressions.length === 0,
    regressions,
    deltas,
    relativeCostIncrease,
    relativeLatencyIncrease,
  };
}

function summarizeEvalRuns(runs = []) {
  const normalized = asArray(runs).filter((run) => run && typeof run === 'object' && Number(run.total || 0) > 0);
  const totalCases = normalized.reduce((sum, run) => sum + Number(run.total || 0), 0);
  const passedCases = normalized.reduce((sum, run) => sum + Number(run.passed || 0), 0);
  const criticalRegressions = normalized.reduce((sum, run) => sum + asArray(run.criticalFailures).length, 0);
  const weightedMetric = (key) => totalCases > 0
    ? normalized.reduce((sum, run) => sum + (Number(run.metrics?.[key] || 0) * Number(run.total || 0)), 0) / totalCases
    : 0;
  const latest = [...normalized].sort((left, right) => (
    String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
  ))[0] || null;
  return {
    schemaVersion: 'EvalSummary/v1',
    totalRuns: normalized.length,
    totalCases,
    passedCases,
    passRate: totalCases > 0 ? passedCases / totalCases : 0,
    criticalRegressions,
    evidenceCoverage: weightedMetric('evidenceCoverage'),
    toolPrecision: weightedMetric('toolPrecision'),
    averageCostUsd: weightedMetric('averageCostUsd'),
    averageLatencyMs: weightedMetric('averageLatencyMs'),
    latestRunAt: latest?.createdAt || null,
    status: normalized.length === 0
      ? 'unavailable'
      : (criticalRegressions > 0 || (totalCases > 0 && passedCases / totalCases < 0.9) ? 'blocked' : 'passed'),
  };
}

function buildPassingFixture(evalCase = {}) {
  const approvalToolId = asArray(evalCase.expectedTools)[0] || 'eval-tool';
  const approvalInputHash = 'a'.repeat(64);
  return {
    caseId: evalCase.id,
    route: evalCase.expectedRoute,
    tools: asArray(evalCase.expectedTools),
    signals: [],
    status: 'completed',
    isolationMaintained: true,
    approvals: asArray(evalCase.validators).includes('approval')
      ? [issueApprovalReceipt({
          id: `approval-${evalCase.id}`,
          runId: `eval-run-${evalCase.id}`,
          toolId: approvalToolId,
          risk: 'external',
          inputHash: approvalInputHash,
          scope: `${approvalToolId}:external`,
          grantedBy: 'eval-self-check',
        })]
      : [],
    evidenceAttestations: asArray(evalCase.requiredEvidenceKinds).map((kind) => createEvidenceAttestation({
      kind,
      subject: `${evalCase.id}:${kind}`,
      verdict: 'pass',
      details: { caseId: evalCase.id, recorded: true },
    })),
    costUsd: Math.min(0.25, Number(evalCase.maxCostUsd || 1)),
    latencyMs: Math.min(1000, Number(evalCase.maxLatencyMs || 1000)),
  };
}

module.exports = {
  EVAL_RUN_VERSION,
  buildPassingFixture,
  compareEvalRuns,
  runEvalSuite,
  summarizeEvalRuns,
  validateCase,
};

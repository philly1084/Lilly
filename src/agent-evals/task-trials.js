'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function candidateHash(actions = []) {
  return crypto.createHash('sha256').update(JSON.stringify(actions)).digest('hex');
}

async function gradeOutcome(check, result, workspace) {
  if (check.type === 'file') {
    const root = await fs.realpath(workspace);
    const target = await fs.realpath(path.resolve(root, check.path));
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outcome outside trial workspace');
    const content = await fs.readFile(target, 'utf8');
    return (check.equals === undefined || content === check.equals)
      && (check.contains === undefined || content.includes(check.contains))
      && (check.sha256 === undefined || crypto.createHash('sha256').update(content).digest('hex') === check.sha256);
  }
  if (check.type === 'json') {
    const actual = String(check.path || '').split('.').reduce((value, key) => value?.[key], result);
    return check.equals !== undefined && JSON.stringify(actual) === JSON.stringify(check.equals);
  }
  throw new Error(`Unsupported outcome grader: ${check.type}`);
}

async function runTaskTrials({ cases, execute, workspace, trials = 3, actions = [], label = 'candidate' }) {
  if (!Array.isArray(cases) || !cases.length || typeof execute !== 'function'
    || !Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error('Invalid task trial configuration');
  const results = [];
  for (const scenario of cases) {
    if (!scenario.id || !scenario.prompt || !scenario.checks?.length) throw new Error('Each task needs an id, prompt and outcome checks');
    for (let trial = 0; trial < trials; trial += 1) {
      const trialWorkspace = await fs.mkdtemp(path.join(workspace, 'trial-'));
      const started = Date.now();
      let result = {};
      let error = null;
      const checks = [];
      try {
        for (const [name, content] of Object.entries(scenario.files || {})) {
          const target = path.resolve(trialWorkspace, name);
          if (path.relative(trialWorkspace, target).startsWith('..')) throw new Error('Fixture outside workspace');
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content);
        }
        result = await execute({ ...scenario, workspace: trialWorkspace, actions, trial });
        for (const check of scenario.checks) {
          try { checks.push({ ...check, passed: await gradeOutcome(check, result, trialWorkspace) }); }
          catch (failure) { checks.push({ ...check, passed: false, error: failure.message }); }
        }
      } catch (failure) { error = failure.message; }
      const passed = !error && checks.length === scenario.checks.length && checks.every((entry) => entry.passed);
      results.push({ caseId: scenario.id, trial, passed, checks, error,
        runId: result.runId || crypto.randomUUID(), workspace: trialWorkspace,
        claimedComplete: ['complete', 'completed'].includes(result.status),
        falseCompletion: !passed && ['complete', 'completed'].includes(result.status),
        unnecessaryQuestions: Number(result.unnecessaryQuestions) || 0,
        repeatedFailures: Number(result.repeatedFailures) || 0,
        costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null,
        durationMs: Date.now() - started });
    }
  }
  const successful = results.filter((entry) => entry.passed).length;
  const knownCosts = results.every((entry) => entry.costUsd !== null);
  const totalCost = knownCosts ? results.reduce((sum, entry) => sum + entry.costUsd, 0) : null;
  return { version: 'TaskTrials/v1', label, candidateHash: candidateHash(actions),
    corpusHash: candidateHash(cases), observedAt: new Date().toISOString(), trials,
    results, metrics: { verifiedCompletion: successful / results.length,
      falseCompletion: results.filter((entry) => entry.falseCompletion).length / results.length,
      unnecessaryQuestions: results.reduce((sum, entry) => sum + entry.unnecessaryQuestions, 0),
      repeatedFailures: results.reduce((sum, entry) => sum + entry.repeatedFailures, 0),
      costPerSuccess: successful && knownCosts ? totalCost / successful : null } };
}

function compareTaskTrials(baseline, candidate, actions = []) {
  const valid = (report) => report?.version === 'TaskTrials/v1' && report.trials >= 3
    && report.results?.length > 0 && report.metrics;
  if (!valid(baseline) || !valid(candidate) || baseline.corpusHash !== candidate.corpusHash
    || candidate.candidateHash !== candidateHash(actions)
    || baseline.results.length !== candidate.results.length) return { passed: false, reason: 'missing_matching_trials' };
  const regressions = baseline.results.some((entry) => entry.passed && !candidate.results.some((next) =>
    next.caseId === entry.caseId && next.trial === entry.trial && next.passed));
  const improved = candidate.metrics.verifiedCompletion > baseline.metrics.verifiedCompletion
    || candidate.metrics.falseCompletion < baseline.metrics.falseCompletion
    || candidate.metrics.unnecessaryQuestions < baseline.metrics.unnecessaryQuestions
    || candidate.metrics.repeatedFailures < baseline.metrics.repeatedFailures;
  const noRegression = ['falseCompletion', 'unnecessaryQuestions', 'repeatedFailures'].every((key) =>
    candidate.metrics[key] <= baseline.metrics[key]);
  return { passed: !regressions && noRegression && improved,
    reason: regressions || !noRegression ? 'regression' : improved ? 'measured_improvement' : 'no_measured_improvement' };
}

module.exports = { candidateHash, gradeOutcome, runTaskTrials, compareTaskTrials };

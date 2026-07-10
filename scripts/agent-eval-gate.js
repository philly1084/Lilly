#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { AGENT_EVAL_CASES } = require('../src/agent-evals/corpus');
const {
  buildPassingFixture,
  compareEvalRuns,
  runEvalSuite,
} = require('../src/agent-evals/runner');
const { readEvalRuns, recordEvalRun } = require('../src/agent-evals/store');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function readResults(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.results)) return parsed.results;
  if (Array.isArray(parsed.caseResults)) return parsed.caseResults;
  throw new Error(`${resolved} must contain an array or a results array.`);
}

function assertRecordedResults(results = [], label = 'results') {
  const allowedModes = new Set(['live-sandbox', 'recorded-tool-replay']);
  const invalid = results.filter((result) => (
    !String(result?.caseId || result?.id || '').trim()
    || !String(result?.runId || result?.agentRunId || '').trim()
    || !allowedModes.has(String(result?.provenance?.mode || '').trim())
    || !String(result?.provenance?.recordedAt || result?.provenance?.completedAt || '').trim()
  ));
  if (invalid.length > 0) {
    throw new Error(`${label} contains ${invalid.length} result(s) without recorded AgentRun provenance.`);
  }
  return results;
}

function summarizeRun(run = {}) {
  return {
    label: run.label,
    total: run.total,
    passed: run.passed,
    failed: run.failed,
    passRate: run.passRate,
    criticalFailures: run.criticalFailures,
    metrics: run.metrics,
  };
}

function main() {
  const selfCheck = process.argv.includes('--self-check');
  const baselinePath = readArg('--baseline');
  const candidatePath = readArg('--candidate');
  const outPath = readArg('--out');
  let baseline;
  let candidate;
  let mode;
  if (selfCheck) {
    baseline = runEvalSuite({
      results: AGENT_EVAL_CASES.map(buildPassingFixture),
      label: 'synthetic-contract-baseline',
    });
    candidate = runEvalSuite({
      results: AGENT_EVAL_CASES.map(buildPassingFixture),
      label: 'synthetic-contract-candidate',
    });
    mode = 'synthetic-contract-self-check';
  } else if (baselinePath && candidatePath) {
    const baselineResults = assertRecordedResults(readResults(baselinePath), 'Baseline');
    const candidateResults = assertRecordedResults(readResults(candidatePath), 'Candidate');
    baseline = runEvalSuite({ results: baselineResults, label: 'baseline' });
    candidate = runEvalSuite({ results: candidateResults, label: 'candidate' });
    mode = 'recorded-results-comparison';
  } else {
    const recordedRuns = readEvalRuns({ limit: 2 });
    if (recordedRuns.length < 2) {
      throw new Error('No release eval comparison is available. Supply --baseline and --candidate recorded results, or record two live/replay EvalRun/v1 runs. Use eval:agent-runs:self-check only to test the contract code.');
    }
    [candidate, baseline] = recordedRuns;
    mode = 'persisted-eval-run-comparison';
  }
  const comparison = compareEvalRuns(baseline, candidate);
  const report = {
    schemaVersion: 'AgentEvalGateReport/v1',
    mode,
    releaseEligible: !selfCheck && comparison.passed,
    createdAt: new Date().toISOString(),
    baseline: summarizeRun(baseline),
    candidate: summarizeRun(candidate),
    comparison,
  };

  if (mode === 'recorded-results-comparison' && !process.argv.includes('--no-record')) {
    recordEvalRun(candidate);
  }

  if (outPath) {
    fs.writeFileSync(path.resolve(process.cwd(), outPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = comparison.passed ? 0 : 1;
}

try {
  main();
} catch (error) {
  console.error(`[AgentEvalGate] ${error.message}`);
  process.exitCode = 1;
}

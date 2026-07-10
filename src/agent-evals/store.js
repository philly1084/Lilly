'use strict';

const path = require('path');
const { PROJECT_ROOT, resolvePreferredWritableFile } = require('../runtime-state-paths');
const {
  appendJsonlRecordSync,
  readJsonlRecordsSync,
} = require('../observability/jsonl-persistence');

function getAgentEvalStoragePath() {
  return resolvePreferredWritableFile(
    path.join(PROJECT_ROOT, 'data', 'observability', 'agent-evals.jsonl'),
    ['observability', 'agent-evals.jsonl'],
  );
}

function isRecordedEvalRun(run = {}) {
  return run
    && typeof run === 'object'
    && run.schemaVersion === 'EvalRun/v1'
    && Number(run.total || 0) > 0
    && !String(run.label || '').startsWith('synthetic-');
}

function recordEvalRun(run = {}, options = {}) {
  if (!isRecordedEvalRun(run)) {
    return false;
  }
  appendJsonlRecordSync(options.storagePath || getAgentEvalStoragePath(), {
    ...run,
    recordedAt: new Date().toISOString(),
  });
  return true;
}

function readEvalRuns(options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
  return readJsonlRecordsSync(options.storagePath || getAgentEvalStoragePath())
    .filter(isRecordedEvalRun)
    .sort((left, right) => String(right.createdAt || right.recordedAt || '').localeCompare(String(left.createdAt || left.recordedAt || '')))
    .slice(0, limit);
}

module.exports = {
  getAgentEvalStoragePath,
  isRecordedEvalRun,
  readEvalRuns,
  recordEvalRun,
};

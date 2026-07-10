'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readEvalRuns, recordEvalRun } = require('./store');

describe('agent eval store', () => {
  test('records real eval runs and rejects synthetic self-check output', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-agent-evals-'));
    const storagePath = path.join(directory, 'agent-evals.jsonl');
    try {
      expect(recordEvalRun({
        schemaVersion: 'EvalRun/v1',
        label: 'synthetic-contract-candidate',
        total: 30,
      }, { storagePath })).toBe(false);
      expect(recordEvalRun({
        schemaVersion: 'EvalRun/v1',
        label: 'candidate',
        createdAt: '2026-07-09T00:00:00.000Z',
        total: 30,
        passed: 28,
        metrics: {},
        caseResults: [],
      }, { storagePath })).toBe(true);
      expect(readEvalRuns({ storagePath })).toEqual([
        expect.objectContaining({ label: 'candidate', total: 30, passed: 28 }),
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

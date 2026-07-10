#!/usr/bin/env node
'use strict';

const { createToolInvocation } = require('../src/tool-invocation');
const { createReplayArchive, replayArchive } = require('../src/agent-runs/offline-replay');

const invocation = createToolInvocation({
  runId: 'offline-replay-check',
  toolId: 'health-check',
  input: { route: '/health' },
  result: { statusCode: 200, ready: true },
  status: 'succeeded',
});
const archive = createReplayArchive({
  run: { id: 'offline-replay-check', state: 'completed', eventCursor: 2 },
  events: [
    { cursor: 1, type: 'run.created', payload: {} },
    { cursor: 2, type: 'run.completed', payload: { invocationId: invocation.id } },
  ],
  toolInvocations: [invocation],
});
const replay = replayArchive(archive);
const output = replay.getRecordedToolOutput(invocation.id);

if (replay.mode !== 'read-only' || replay.events.length !== 2 || output?.statusCode !== 200) {
  process.stderr.write('Agent offline replay check failed.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    version: replay.version,
    mode: replay.mode,
    events: replay.events.length,
    recordedOutput: output,
    archiveDigest: archive.digest,
  }, null, 2)}\n`);
}

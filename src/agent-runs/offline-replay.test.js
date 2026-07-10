'use strict';

const { createToolInvocation } = require('../tool-invocation');
const { createReplayArchive, replayArchive } = require('./offline-replay');

describe('offline AgentRun replay', () => {
  test('replays recorded outputs without invoking a live tool', () => {
    const liveTool = jest.fn();
    const invocation = createToolInvocation({
      runId: 'run-replay',
      toolId: 'web-fetch',
      input: { url: 'https://example.test' },
      result: { statusCode: 200, body: 'recorded body' },
      status: 'succeeded',
    });
    const archive = createReplayArchive({
      run: { id: 'run-replay', state: 'completed', eventCursor: 2 },
      events: [
        { cursor: 1, type: 'run.created', payload: {} },
        { cursor: 2, type: 'run.step', payload: { invocationId: invocation.id } },
      ],
      toolInvocations: [invocation],
    });
    const replay = replayArchive(archive);

    expect(replay.mode).toBe('read-only');
    expect(replay.getRecordedToolOutput(invocation.id)).toEqual({ statusCode: 200, body: 'recorded body' });
    expect(liveTool).not.toHaveBeenCalled();
  });

  test('redacts credentials and bounds recorded command output', () => {
    const invocation = createToolInvocation({
      runId: 'run-secret',
      toolId: 'remote-command',
      input: { command: 'status' },
      result: {
        authorization: 'Bearer secret-value',
        output: `Bearer abcdefghijklmnop ${'x'.repeat(4000)}`,
      },
      status: 'succeeded',
    });
    const archive = createReplayArchive({
      run: { id: 'run-secret' },
      events: [{ cursor: 1, type: 'run.created', payload: { apiKey: 'sk-secretsecret' } }],
      toolInvocations: [invocation],
    });
    const serialized = JSON.stringify(archive);

    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(serialized).toContain('[REDACTED]');
    expect(archive.toolInvocations[0].recordedOutput.output).toContain('[truncated');
  });

  test('rejects duplicate or out-of-order event cursors', () => {
    expect(() => createReplayArchive({
      run: { id: 'run-order' },
      events: [{ cursor: 2 }, { cursor: 1 }],
    })).toThrow('cursor order');
  });

  test('rejects a replay archive whose recorded output was changed', () => {
    const invocation = createToolInvocation({
      runId: 'run-tampered',
      toolId: 'web-fetch',
      input: { url: 'https://example.test' },
      result: { statusCode: 200 },
      status: 'succeeded',
    });
    const archive = createReplayArchive({
      run: { id: 'run-tampered' },
      events: [{ cursor: 1, type: 'run.created', payload: {} }],
      toolInvocations: [invocation],
    });
    archive.toolInvocations[0].recordedOutput.statusCode = 500;

    expect(() => replayArchive(archive)).toThrow('output digest mismatch');
  });
});

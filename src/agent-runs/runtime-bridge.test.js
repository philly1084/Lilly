'use strict';

const { EventEmitter } = require('events');
const { AsyncLabStore } = require('../async-lab/store');
const { AgentRunService } = require('./service');
const {
  advanceSurfaceAgentRun,
  attachAgentRunMetadata,
  attachSseAgentRunMetadata,
  beginSurfaceAgentRun,
  deriveSurfaceSourceId,
  findTransitionPath,
  installHttpAgentRunResponseBridge,
  extractAgentRunCompletionData,
} = require('./runtime-bridge');
const { createEvidenceAttestation } = require('../agent-evidence');
const { createToolInvocation } = require('../tool-invocation');

function createService() {
  return new AgentRunService({
    store: new AsyncLabStore({ persistToPostgres: false }),
  });
}

function createResponse() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode: 200,
    locals: {},
    json: jest.fn((payload) => payload),
    write: jest.fn(() => true),
    end: jest.fn(() => true),
  });
}

describe('AgentRun runtime shadow bridge', () => {
  test('derives stable source ids from authoritative surface identifiers', () => {
    expect(deriveSurfaceSourceId({ responseId: 'resp-1', sessionId: 'session-1' })).toBe('resp-1');
    expect(deriveSurfaceSourceId({ jobId: 'job-1' })).toBe('job-1');
    expect(deriveSurfaceSourceId({
      sessionId: 'session-1',
      operation: 'chat',
      objective: 'Ship the site',
    })).toBe(deriveSurfaceSourceId({
      sessionId: 'session-1',
      operation: 'chat',
      objective: 'Ship the site',
    }));
  });

  test('finds legal canonical paths without skipping verification', () => {
    expect(findTransitionPath('created', 'completed')).toEqual([
      'planning',
      'executing',
      'verifying',
      'completed',
    ]);
    expect(findTransitionPath('executing', 'failed')).toEqual(['failed']);
  });

  test('captures an idempotent executing run and advances it to completion', async () => {
    const service = createService();
    const input = {
      agentRunService: service,
      surface: 'web-chat',
      sourceId: 'response-42',
      sessionId: 'session-1',
      ownerId: 'phill',
      objective: 'Build and launch a microsite',
      state: 'executing',
    };
    const first = await beginSurfaceAgentRun(input);
    const duplicate = await beginSurfaceAgentRun(input);

    expect(first.run.state).toBe('executing');
    expect(duplicate.run.id).toBe(first.run.id);
    expect(duplicate.duplicate).toBe(true);

    await advanceSurfaceAgentRun(first, 'completed', {
      details: { responseId: 'response-42' },
    });
    expect(first.run.state).toBe('completed');
    expect(first.run.snapshot.legacyDetails.responseId).toBe('response-42');
  });

  test('does not let automatic completion override pause or cancellation controls', async () => {
    const service = createService();
    const pausedHandle = await beginSurfaceAgentRun({
      agentRunService: service,
      surface: 'web-chat',
      sourceId: 'controlled-pause',
      ownerId: 'phill',
      state: 'executing',
    });
    await service.performAction(pausedHandle.run.id, {
      action: 'pause',
      idempotencyKey: 'controlled-pause-action',
      approval: { id: 'controlled-approval' },
    }, 'phill');

    await advanceSurfaceAgentRun(pausedHandle, 'completed');
    expect(pausedHandle.run.state).toBe('waiting_for_approval');
    expect(pausedHandle.controlState).toEqual(expect.objectContaining({
      paused: true,
      canAdvance: false,
    }));

    await service.performAction(pausedHandle.run.id, {
      action: 'resume',
      idempotencyKey: 'controlled-resume-action',
    }, 'phill');
    await advanceSurfaceAgentRun(pausedHandle, 'completed');
    expect(pausedHandle.run.state).toBe('completed');

    const cancelledHandle = await beginSurfaceAgentRun({
      agentRunService: service,
      surface: 'web-chat',
      sourceId: 'controlled-cancel',
      ownerId: 'phill',
      state: 'executing',
    });
    await service.performAction(cancelledHandle.run.id, {
      action: 'cancel',
      idempotencyKey: 'controlled-cancel-action',
    }, 'phill');
    await advanceSurfaceAgentRun(cancelledHandle, 'completed');

    expect(cancelledHandle.run.state).toBe('cancelled');
    expect(cancelledHandle.controlState).toEqual(expect.objectContaining({
      cancelRequested: true,
      canAdvance: false,
    }));
  });

  test('does not auto-adopt a fork past its inherited approval gate', async () => {
    const service = createService();
    const source = await beginSurfaceAgentRun({
      agentRunService: service,
      surface: 'web-chat',
      sourceId: 'fork-control-source',
      ownerId: 'phill',
      state: 'executing',
    });
    await service.performAction(source.run.id, {
      action: 'pause',
      idempotencyKey: 'fork-control-pause',
      approval: {
        id: 'fork-control-approval',
        kind: 'tool_invocation',
        runId: source.run.id,
        toolId: 'remote-command',
        risk: 'external',
        inputHash: 'a'.repeat(64),
        scope: 'remote-command:external',
      },
    }, 'phill');
    const forked = await service.performAction(source.run.id, {
      action: 'fork',
      idempotencyKey: 'fork-control-child',
    }, 'phill');

    const adopted = await beginSurfaceAgentRun({
      agentRunService: service,
      existingRunId: forked.forkedRun.id,
      surface: 'web-chat',
      ownerId: 'phill',
      state: 'executing',
    });

    expect(adopted.run.state).toBe('waiting_for_approval');
    expect(adopted.controlState).toEqual(expect.objectContaining({
      paused: true,
      pendingApprovalCount: 1,
    }));
  });

  test('adopts a mission run instead of creating a parallel chat run', async () => {
    const service = createService();
    const created = await service.createRun({
      objective: 'Build the mission',
      surface: 'web-chat',
      sessionId: 'mission-session',
    }, 'phill');
    const adopted = await beginSurfaceAgentRun({
      agentRunService: service,
      existingRunId: created.run.id,
      surface: 'web-chat',
      mode: 'chat',
      sessionId: 'mission-session',
      ownerId: 'phill',
      sourceId: 'chat-request-1',
      state: 'executing',
    });

    expect(adopted.adopted).toBe(true);
    expect(adopted.run.id).toBe(created.run.id);
    expect(adopted.run.state).toBe('executing');
    expect(await service.getRun(created.run.id, 'phill')).toEqual(expect.objectContaining({ state: 'executing' }));
  });

  test('never fails the legacy request when canonical persistence fails', async () => {
    const logger = { warn: jest.fn() };
    const handle = await beginSurfaceAgentRun({
      agentRunService: {
        createRun: jest.fn(async () => { throw new Error('store offline'); }),
        transitionRun: jest.fn(),
      },
      allowSharedFallback: false,
      surface: 'chat',
      sourceId: 'request-1',
      logger,
    });

    expect(handle).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('without affecting the legacy request'));
  });

  test('adds canonical run and normalized event metadata without replacing legacy run ids', async () => {
    const handle = await beginSurfaceAgentRun({
      agentRunService: createService(),
      surface: 'workload',
      sourceId: 'workload-run-9',
      state: 'executing',
    });
    const attached = attachAgentRunMetadata({ runId: 'legacy-run-9', ok: true }, handle, {
      eventType: 'workload.started',
    });

    expect(attached.runId).toBe('legacy-run-9');
    expect(attached.agentRunId).toBe(handle.run.id);
    expect(attached.agentRun.version).toBe('AgentRun/v1');
    expect(attached.agentRunEvent).toMatchObject({
      version: 'AgentRunEvent/v1',
      runId: handle.run.id,
      type: 'workload.started',
    });
    expect(attached.metadata.agentRun.id).toBe(handle.run.id);
  });

  test('decorates JSON SSE frames while preserving the done sentinel', async () => {
    const handle = await beginSurfaceAgentRun({
      agentRunService: createService(),
      surface: 'openai-compatible',
      sourceId: 'request-7',
    });
    const transformed = attachSseAgentRunMetadata(
      'data: {"type":"delta","content":"hi"}\n\ndata: [DONE]\n\n',
      handle,
    );

    expect(transformed).toContain(`"runId":"${handle.run.id}"`);
    expect(transformed).toContain('data: [DONE]');
  });

  test('HTTP integration exposes the run immediately and finalizes asynchronously', async () => {
    const service = createService();
    const handle = await beginSurfaceAgentRun({
      agentRunService: service,
      surface: 'chat',
      sourceId: 'request-http-1',
    });
    const req = { method: 'POST', originalUrl: '/api/chat' };
    const res = createResponse();
    installHttpAgentRunResponseBridge(req, res, handle);

    const payload = res.json({ ok: true });
    expect(payload.runId).toBe(handle.run.id);
    expect(payload.agentRunEvent.type).toBe('surface.response');

    await new Promise((resolve) => setImmediate(resolve));
    const persisted = await service.getRun(handle.run.id);
    expect(persisted.state).toBe('completed');
  });

  test('marks an HTTP 200 SSE response failed when a captured frame contains an error', async () => {
    const service = createService();
    const handle = await beginSurfaceAgentRun({
      agentRunService: service,
      surface: 'chat',
      sourceId: 'request-http-error-1',
    });
    const req = { method: 'POST', originalUrl: '/api/chat' };
    const res = createResponse();
    installHttpAgentRunResponseBridge(req, res, handle);

    res.write('data: {"type":"error","statusCode":401,"errorCode":"UPSTREAM_AUTH","error":{"message":"Unauthorized"}}\n\n');
    res.end('data: [DONE]\n\n');

    await new Promise((resolve) => setImmediate(resolve));
    const persisted = await service.getRun(handle.run.id);
    expect(persisted.state).toBe('failed');
    expect(persisted.completion.status).toBe('failed');
  });

  test('promotes only valid typed tool evidence and artifacts into the completed run', async () => {
    const service = createService();
    const handle = await beginSurfaceAgentRun({
      agentRunService: service,
      surface: 'chat',
      sourceId: 'request-proof-1',
    });
    const invocationId = 'invocation-proof-1';
    const evidence = createEvidenceAttestation({
      kind: 'test',
      subject: 'Focused tests',
      verdict: 'pass',
      details: { exitCode: 0 },
      sourceInvocationId: invocationId,
    });
    const invocation = createToolInvocation({
      id: invocationId,
      runId: handle.run.id,
      toolId: 'test-runner',
      input: { command: 'npm test' },
      evidence: [evidence],
      result: { exitCode: 0 },
      status: 'succeeded',
    });
    const completion = extractAgentRunCompletionData({
      toolEvents: [{ result: { invocation } }],
      artifacts: [{ id: 'artifact-1', filename: 'report.html', previewUrl: '/artifacts/1' }],
    }, { runId: handle.run.id });
    handle.completionData = completion;

    await advanceSurfaceAgentRun(handle, 'completed');
    const persisted = await service.getRun(handle.run.id);
    expect(persisted.invocations).toEqual([invocation]);
    expect(persisted.evidence).toEqual([evidence]);
    expect(persisted.outputs).toEqual([
      expect.objectContaining({ id: 'artifact-1', filename: 'report.html' }),
    ]);
    expect(persisted.proofPack.checks).toEqual([
      expect.objectContaining({ kind: 'test', status: 'pass' }),
    ]);
  });

  test('rejects naked evidence and signed invocations outside the current proof scope', async () => {
    const service = createService();
    const handle = await beginSurfaceAgentRun({
      agentRunService: service,
      surface: 'chat',
      sourceId: 'request-proof-scope',
    });
    const nakedEvidence = createEvidenceAttestation({
      kind: 'test',
      subject: 'Unbound test claim',
      verdict: 'pass',
      details: { exitCode: 0 },
    });
    const wrongRunInvocation = createToolInvocation({
      id: 'invocation-other-run',
      runId: 'another-agent-run',
      toolId: 'test-runner',
      result: { exitCode: 0 },
      status: 'succeeded',
    });
    const mismatchedEvidence = createEvidenceAttestation({
      kind: 'test',
      subject: 'Mismatched invocation claim',
      verdict: 'pass',
      details: { exitCode: 0 },
      sourceInvocationId: 'different-invocation',
    });
    const unboundInvocation = createToolInvocation({
      id: 'invocation-unbound',
      runId: handle.run.id,
      toolId: 'test-runner',
      evidence: [mismatchedEvidence],
      result: { exitCode: 0 },
      status: 'succeeded',
    });

    const completion = extractAgentRunCompletionData({
      evidence: [nakedEvidence],
      invocation: wrongRunInvocation,
      nested: { invocation: unboundInvocation },
    }, { runId: handle.run.id });

    expect(completion.evidence).toEqual([]);
    expect(completion.invocations).toEqual([]);
  });
});

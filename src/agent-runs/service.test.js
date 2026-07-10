'use strict';

const { AsyncLabStore } = require('../async-lab/store');
const {
  AGENT_RUN_VERSION,
  AgentRunService,
  attachLegacyAgentRunEnvelope,
  captureLegacyAgentRun,
  redactAndBound,
} = require('./index');
const { normalizeApprovalReceipt } = require('../tool-invocation');

function createService() {
  return new AgentRunService({
    store: new AsyncLabStore({ persistToPostgres: false }),
  });
}

async function createExecutingRun(service, suffix = 'run') {
  const created = await service.createRun({
    objective: `Execute ${suffix}`,
    idempotencyKey: `create-${suffix}`,
  }, 'tester');
  await service.transitionRun(created.run.id, 'planning', { ownerId: 'tester' });
  const executing = await service.transitionRun(created.run.id, 'executing', { ownerId: 'tester' });
  return executing.run;
}

describe('AgentRunService', () => {
  test('creates one canonical run for an idempotency key', async () => {
    const service = createService();
    const input = {
      objective: 'Prepare a release brief',
      sessionId: 'session-1',
      surface: 'web-chat',
      idempotencyKey: 'release-brief-1',
    };

    const first = await service.createRun(input, 'tester');
    const second = await service.createRun(input, 'tester');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(first.run).toEqual(expect.objectContaining({
      version: AGENT_RUN_VERSION,
      ownerId: 'tester',
      sessionId: 'session-1',
      objective: 'Prepare a release brief',
      state: 'created',
      eventCursor: 1,
    }));
    expect(second.events).toHaveLength(1);
    expect(second.events[0].type).toBe('run.created');

    const anotherOwner = await service.createRun(input, 'another-owner');
    expect(anotherOwner.duplicate).toBe(false);
    expect(anotherOwner.run.id).not.toBe(first.run.id);
  });

  test('enforces legal state transitions through completion', async () => {
    const service = createService();
    const created = await service.createRun({ objective: 'Ship safely' }, 'tester');
    let current = created.run;

    for (const state of ['planning', 'executing', 'verifying', 'completed']) {
      const result = await service.transitionRun(current.id, state, { ownerId: 'tester' });
      current = result.run;
      expect(current.state).toBe(state);
    }

    await expect(service.transitionRun(current.id, 'executing', { ownerId: 'tester' }))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'ILLEGAL_AGENT_RUN_TRANSITION',
      });
  });

  test('replays ordered events from an exclusive reconnect cursor', async () => {
    const service = createService();
    const run = await createExecutingRun(service, 'replay');
    await service.recordStep(run.id, {
      id: 'step-1',
      status: 'completed',
      output: 'Collected facts',
    }, {
      ownerId: 'tester',
      idempotencyKey: 'step-1',
    });
    await service.performAction(run.id, {
      action: 'pause',
      idempotencyKey: 'pause-replay',
      reason: 'Review evidence',
    }, 'tester');

    const replay = await service.replayRun(run.id, 2, 'tester');
    const cursors = replay.events.map((event) => event.cursor);

    expect(cursors.every((cursor) => cursor > 2)).toBe(true);
    expect(cursors).toEqual([...cursors].sort((left, right) => left - right));
    expect(replay.eventCursor).toBe(Math.max(...cursors));
    expect(replay.run.eventCursor).toBe(replay.eventCursor);
  });

  test('persists pause and resume metadata without duplicating action events', async () => {
    const service = createService();
    const run = await createExecutingRun(service, 'pause-resume');
    const pauseInput = {
      action: 'pause',
      idempotencyKey: 'pause-1',
      reason: 'Human sign-off',
      approval: {
        id: 'approval-1',
        password: 'must-not-leak',
      },
    };

    const paused = await service.performAction(run.id, pauseInput, 'tester');
    const duplicatePause = await service.performAction(run.id, pauseInput, 'tester');
    const resumed = await service.performAction(run.id, {
      action: 'resume',
      idempotencyKey: 'resume-1',
    }, 'tester');
    const persisted = await service.getRun(run.id, 'tester');
    const events = await service.listEvents(run.id, 0, 'tester');

    expect(paused.run.state).toBe('waiting_for_approval');
    expect(paused.run.control).toEqual(expect.objectContaining({
      paused: true,
      canAdvance: false,
      pendingApprovalCount: 1,
    }));
    expect(paused.run.snapshot.pause).toEqual(expect.objectContaining({
      pausedFrom: 'executing',
      approvalId: 'approval-1',
    }));
    expect(paused.run.approvals[0].password).toBe('[REDACTED]');
    expect(duplicatePause.duplicate).toBe(true);
    expect(resumed.run.state).toBe('executing');
    expect(resumed.run.control.canAdvance).toBe(true);
    expect(persisted.state).toBe('executing');
    expect(persisted.snapshot.pause.resolution).toBe('resumed');
    expect(persisted.approvals[0]).toEqual(expect.objectContaining({
      id: 'approval-1',
      status: 'approved',
    }));
    expect(events.filter((event) => event.type === 'run.action')).toHaveLength(2);
  });

  test('replaces an exact-scoped tool approval request with a signed short-lived receipt', async () => {
    const service = createService();
    const run = await createExecutingRun(service, 'tool-approval');
    const inputHash = 'a'.repeat(64);
    await service.performAction(run.id, {
      action: 'pause',
      idempotencyKey: 'tool-approval-pause',
      approval: {
        id: 'approval-tool-1',
        kind: 'tool_invocation',
        runId: run.id,
        toolId: 'remote-command',
        risk: 'external',
        inputHash,
        scope: 'remote-command:external',
      },
    }, 'tester');

    const resumed = await service.performAction(run.id, {
      action: 'resume',
      idempotencyKey: 'tool-approval-resume',
    }, 'tester');
    const receipt = resumed.run.approvals[0];

    expect(receipt).toEqual(expect.objectContaining({
      version: 'ApprovalReceipt/v1',
      id: 'approval-tool-1',
      status: 'approved',
      runId: run.id,
      toolId: 'remote-command',
      risk: 'external',
      inputHash,
      grantedBy: 'tester',
      scope: 'remote-command:external',
      authority: expect.objectContaining({
        version: 'ApprovalAuthority/v1',
        issuer: 'kimibuilt-runtime',
      }),
    }));
    expect(normalizeApprovalReceipt(receipt)).toEqual(receipt);
    expect(Date.parse(receipt.expiresAt) - Date.parse(receipt.grantedAt)).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(resumed.run.snapshot.pause.approvalReceiptId).toBe('approval-tool-1');
  });

  test('refuses to persist a tool approval request scoped to another run', async () => {
    const service = createService();
    const run = await createExecutingRun(service, 'invalid-tool-approval');
    await expect(service.performAction(run.id, {
      action: 'pause',
      idempotencyKey: 'invalid-tool-approval-pause',
      approval: {
        id: 'approval-tool-invalid',
        kind: 'tool_invocation',
        runId: 'another-agent-run',
        toolId: 'remote-command',
        risk: 'external',
        inputHash: 'b'.repeat(64),
      },
    }, 'tester')).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_TOOL_APPROVAL_SCOPE',
    });
    expect((await service.getRun(run.id, 'tester')).state).toBe('executing');
  });

  test('persists cancellation as a terminal snapshot and event', async () => {
    const service = createService();
    const created = await service.createRun({ objective: 'Cancelable work' }, 'tester');
    const cancelled = await service.performAction(created.run.id, {
      action: 'cancel',
      idempotencyKey: 'cancel-1',
      reason: 'No longer needed',
    }, 'tester');
    const persisted = await service.getRun(created.run.id, 'tester');

    expect(cancelled.run.state).toBe('cancelled');
    expect(cancelled.run.control).toEqual(expect.objectContaining({
      cancelRequested: true,
      canAdvance: false,
      terminal: true,
    }));
    expect(persisted).toEqual(expect.objectContaining({
      state: 'cancelled',
      completion: expect.objectContaining({
        status: 'cancelled',
        reason: 'No longer needed',
      }),
    }));
    expect(persisted.snapshot.lastAction.action).toBe('cancel');
  });

  test('resumes preflight and blocked pauses into useful nonterminal states', async () => {
    const service = createService();
    const preflight = await service.createRun({ objective: 'Preflight approval' }, 'tester');
    await service.performAction(preflight.run.id, { action: 'pause' }, 'tester');
    const resumedPreflight = await service.performAction(preflight.run.id, { action: 'resume' }, 'tester');

    const blocked = await service.createRun({ objective: 'Blocked approval' }, 'tester');
    await service.transitionRun(blocked.run.id, 'blocked', { ownerId: 'tester' });
    await service.performAction(blocked.run.id, { action: 'pause' }, 'tester');
    const resumedBlocked = await service.performAction(blocked.run.id, { action: 'resume' }, 'tester');

    expect(resumedPreflight.run.state).toBe('planning');
    expect(resumedBlocked.run.state).toBe('executing');
  });

  test('forks with clean authority and proof state plus stable lineage', async () => {
    const service = createService();
    const source = await service.createRun({
      objective: 'Explore an implementation',
      approvals: [{ id: 'old-approval', status: 'approved' }],
      evidence: [{ id: 'evidence-1', title: 'Baseline' }],
      outputs: [{ id: 'artifact-old', filename: 'old.html' }],
      usage: { costUsd: 1.25 },
      plan: [{ id: 'old-plan-step' }],
      snapshot: { workspace: { branch: 'codex/demo' } },
    }, 'tester');
    const forkInput = {
      action: 'fork',
      idempotencyKey: 'fork-option-b',
      objective: 'Explore option B',
      snapshot: { hypothesis: 'option-b' },
    };

    const first = await service.performAction(source.run.id, forkInput, 'tester');
    const second = await service.performAction(source.run.id, forkInput, 'tester');
    const parentEvents = await service.listEvents(source.run.id, 0, 'tester');

    expect(first.forkedRun).toEqual(expect.objectContaining({
      parentRunId: source.run.id,
      objective: 'Explore option B',
      state: 'created',
      approvals: [],
      evidence: [],
      invocations: [],
      outputs: [],
      usage: {},
      plan: [],
    }));
    expect(first.forkedRun.id).not.toBe(source.run.id);
    expect(first.forkedRun.snapshot).toEqual(expect.objectContaining({
      hypothesis: 'option-b',
      forkedFrom: source.run.id,
      lineage: expect.objectContaining({
        parentRunId: source.run.id,
        parentEventCursor: source.run.eventCursor,
      }),
    }));
    expect(first.forkedRun.snapshot.workspace).toBeUndefined();
    expect(second.duplicate).toBe(true);
    expect(second.forkedRun.id).toBe(first.forkedRun.id);
    expect(parentEvents.filter((event) => event.type === 'run.action')).toHaveLength(1);
  });

  test('appends a fork instruction to the inherited objective when no override is supplied', async () => {
    const service = createService();
    const source = await service.createRun({ objective: 'Build the launch site' }, 'tester');

    const forked = await service.performAction(source.run.id, {
      action: 'fork',
      instruction: 'Use a smaller static architecture.',
      idempotencyKey: 'fork-static-instruction',
    }, 'tester');

    expect(forked.forkedRun.objective).toBe(
      'Build the launch site\n\nFork instruction: Use a smaller static architecture.',
    );
    expect(forked.forkedRun.snapshot.forkInstruction).toBe('Use a smaller static architecture.');
  });

  test('keeps a fork gated when the source has a pending approval', async () => {
    const service = createService();
    const source = await createExecutingRun(service, 'fork-approval-gate');
    await service.performAction(source.id, {
      action: 'pause',
      idempotencyKey: 'pause-before-fork',
      approval: {
        id: 'approval-fork-1',
        kind: 'tool_invocation',
        runId: source.id,
        toolId: 'remote-command',
        risk: 'external',
        inputHash: 'c'.repeat(64),
      },
    }, 'tester');

    const forked = await service.performAction(source.id, {
      action: 'fork',
      idempotencyKey: 'fork-with-gate',
    }, 'tester');
    const duplicate = await service.performAction(source.id, {
      action: 'fork',
      idempotencyKey: 'fork-with-gate',
    }, 'tester');

    expect(forked.forkedRun).toEqual(expect.objectContaining({
      parentRunId: source.id,
      state: 'waiting_for_approval',
      control: expect.objectContaining({
        paused: true,
        canAdvance: false,
        pendingApprovalCount: 1,
      }),
    }));
    expect(forked.forkedRun.approvals).toEqual([
      expect.objectContaining({
        id: 'approval-fork-1',
        status: 'pending',
        runId: forked.forkedRun.id,
        scope: 'remote-command:external',
      }),
    ]);
    expect(forked.forkedRun.snapshot.inheritedApprovalGate.pendingApprovalIds)
      .toEqual(['approval-fork-1']);
    expect(duplicate.forkedRun.id).toBe(forked.forkedRun.id);
    expect(duplicate.forkedRun.state).toBe('waiting_for_approval');

    const resumed = await service.performAction(forked.forkedRun.id, {
      action: 'resume',
      idempotencyKey: 'resume-fork-with-gate',
    }, 'tester');
    expect(normalizeApprovalReceipt(resumed.run.approvals[0])).toEqual(resumed.run.approvals[0]);
    expect(resumed.run.approvals[0].runId).toBe(forked.forkedRun.id);
  });

  test('reconciles an action event when the following run update failed', async () => {
    const service = createService();
    const created = await service.createRun({ objective: 'Reconcile pause write' }, 'tester');
    const originalUpdateRun = service.store.updateRun.bind(service.store);
    let failNextUpdate = true;
    service.store.updateRun = async (...args) => {
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new Error('simulated post-event update failure');
      }
      return originalUpdateRun(...args);
    };
    const action = {
      action: 'pause',
      idempotencyKey: 'pause-reconcile-once',
      approval: { id: 'approval-reconcile-1' },
    };

    await expect(service.performAction(created.run.id, action, 'tester'))
      .rejects.toThrow('simulated post-event update failure');
    const reconciled = await service.performAction(created.run.id, action, 'tester');
    const persisted = await service.getRun(created.run.id, 'tester');
    const events = await service.listEvents(created.run.id, 0, 'tester');

    expect(reconciled.duplicate).toBe(true);
    expect(reconciled.run.state).toBe('waiting_for_approval');
    expect(persisted.state).toBe('waiting_for_approval');
    expect(persisted.approvals).toEqual([
      expect.objectContaining({ id: 'approval-reconcile-1', status: 'pending' }),
    ]);
    expect(events.filter((event) => event.type === 'run.action')).toHaveLength(1);
  });

  test('redacts recursive secrets and bounds persisted payloads', async () => {
    const service = createService();
    const created = await service.createRun({
      objective: 'Handle untrusted tool output',
      snapshot: {
        authorization: 'Bearer live-key',
        nested: {
          apiKey: 'sk-secret',
          cookie: 'session=value',
          password: 'hunter2',
          token: 'opaque-secret',
        },
        longText: 'x'.repeat(6000),
        rows: Array.from({ length: 80 }, (_value, index) => index),
      },
      evidence: [{ id: 'e-1', secret: 'private evidence' }],
      outputs: [{ id: 'o-1', api_key: 'private output' }],
    }, 'tester');
    const transitioned = await service.transitionRun(created.run.id, 'planning', {
      ownerId: 'tester',
      details: { authorization: 'Bearer event-secret' },
    });

    expect(created.run.snapshot.authorization).toBe('[REDACTED]');
    expect(created.run.snapshot.nested).toEqual({
      apiKey: '[REDACTED]',
      cookie: '[REDACTED]',
      password: '[REDACTED]',
      token: '[REDACTED]',
    });
    expect(created.run.snapshot.longText.length).toBeLessThanOrEqual(4000);
    expect(created.run.snapshot.longText).toMatch(/truncated/);
    expect(created.run.snapshot.rows.length).toBeLessThanOrEqual(51);
    expect(created.run.evidence[0].secret).toBe('[REDACTED]');
    expect(created.run.outputs[0].api_key).toBe('[REDACTED]');
    expect(transitioned.event.payload.details.authorization).toBe('[REDACTED]');
    expect(redactAndBound({ refreshToken: 'private' }).refreshToken).toBe('[REDACTED]');
    expect(redactAndBound({ continuationToken: 'agent-cont-safe-handle' }).continuationToken)
      .toBe('agent-cont-safe-handle');
    expect(redactAndBound({ message: 'Authorization: Bearer live-secret-value' }).message)
      .toBe('Authorization: Bearer [REDACTED]');
  });

  test('records a terminal step once and updates the snapshot', async () => {
    const service = createService();
    const run = await createExecutingRun(service, 'terminal-step');
    await service.transitionRun(run.id, 'verifying', { ownerId: 'tester' });
    const input = {
      id: 'verify-step',
      state: 'completed',
      output: { summary: 'All checks passed', apiKey: 'never-store-this' },
      evidence: [{ id: 'terminal-proof', status: 'passed' }],
      outputs: [{ id: 'terminal-output', title: 'Verification report' }],
    };
    const first = await service.recordStep(run.id, input, {
      ownerId: 'tester',
      idempotencyKey: 'verify-step-1',
    });
    const second = await service.recordStep(run.id, input, {
      ownerId: 'tester',
      idempotencyKey: 'verify-step-1',
    });
    const events = await service.listEvents(run.id, 0, 'tester');

    expect(first.run.state).toBe('completed');
    expect(first.run.snapshot.lastStep.output.apiKey).toBe('[REDACTED]');
    expect(first.run.evidence).toEqual([{ id: 'terminal-proof', status: 'passed' }]);
    expect(first.run.outputs).toEqual([{ id: 'terminal-output', title: 'Verification report' }]);
    expect(second.duplicate).toBe(true);
    expect(events.filter((event) => event.type === 'run.step')).toHaveLength(1);
  });

  test('recovers through a new service instance without repeating an idempotent write step', async () => {
    const store = new AsyncLabStore({ persistToPostgres: false });
    const beforeRestart = new AgentRunService({ store });
    const created = await beforeRestart.createRun({ objective: 'Persist one bounded write' }, 'tester');
    await beforeRestart.transitionRun(created.run.id, 'planning', { ownerId: 'tester' });
    await beforeRestart.transitionRun(created.run.id, 'executing', { ownerId: 'tester' });
    const first = await beforeRestart.recordStep(created.run.id, {
      id: 'write-file',
      status: 'succeeded',
      outputs: [{ id: 'file-1', path: 'workspace/index.html' }],
    }, {
      ownerId: 'tester',
      idempotencyKey: 'write-file-once',
    });

    const afterRestart = new AgentRunService({ store });
    const resumed = await afterRestart.recordStep(created.run.id, {
      id: 'write-file',
      status: 'succeeded',
      outputs: [{ id: 'file-1', path: 'workspace/index.html' }],
    }, {
      ownerId: 'tester',
      idempotencyKey: 'write-file-once',
    });
    const events = await afterRestart.listEvents(created.run.id, 0, 'tester');

    expect(first.duplicate).toBe(false);
    expect(resumed.duplicate).toBe(true);
    expect(events.filter((event) => event.type === 'run.step')).toHaveLength(1);
  });

  test('clears terminal completion metadata when a failed step is retried', async () => {
    const service = createService();
    const created = await service.createRun({ objective: 'Retry failed work' }, 'tester');
    const failed = await service.transitionRun(created.run.id, 'failed', {
      ownerId: 'tester',
      reason: 'Transient provider failure',
    });
    const retried = await service.performAction(created.run.id, {
      action: 'retry-step',
      stepId: 'provider-call',
      idempotencyKey: 'retry-provider-call',
    }, 'tester');

    expect(failed.run.completion.status).toBe('failed');
    expect(retried.run.state).toBe('executing');
    expect(retried.run.completion).toBeNull();
    expect(retried.run.snapshot.retryCount).toBe(1);
  });

  test('captures and attaches a legacy execution without changing legacy callers', async () => {
    const service = createService();
    const legacy = {
      traceId: 'trace-42',
      sessionId: 'legacy-session',
      task: 'Legacy completed task',
      status: 'success',
      output: 'done',
    };

    const captured = await captureLegacyAgentRun(service, legacy, {
      evidence: [{ id: 'legacy-proof' }],
      snapshot: { legacyOutput: legacy.output },
    });
    const duplicate = await captureLegacyAgentRun(service, legacy);
    const response = attachLegacyAgentRunEnvelope({ id: 'response-1' }, captured.run);

    expect(captured.run).toEqual(expect.objectContaining({
      sessionId: 'legacy-session',
      objective: 'Legacy completed task',
      state: 'completed',
    }));
    expect(captured.events.filter((event) => event.type === 'run.legacy_state')).toHaveLength(4);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.run.id).toBe(captured.run.id);
    expect(response.agentRun.id).toBe(captured.run.id);
    expect(response.metadata.agentRun.version).toBe(AGENT_RUN_VERSION);
  });

  test('copies hostile object keys without mutating object prototypes', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}');
    const sanitized = redactAndBound(hostile);

    expect(sanitized.safe).toBe('value');
    expect(Object.prototype.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(sanitized, '__proto__')).toBe(true);
  });
});

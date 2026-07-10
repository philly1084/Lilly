'use strict';

const { createEvidenceAttestation } = require('./agent-evidence');
const {
  TOOL_INVOCATION_VERSION,
  createToolInvocation,
  decideToolInvocationApproval,
  inferToolInvocationRisk,
  issueApprovalReceipt,
  validateToolInvocation,
} = require('./tool-invocation');

describe('ToolInvocation/v2', () => {
  test('builds stable input hashes and idempotency keys from structured input', () => {
    const first = createToolInvocation({
      runId: 'run-1',
      toolId: 'git-safe',
      toolVersion: '2.0.0',
      input: { action: 'status', repositoryPath: '/repo' },
    });
    const second = createToolInvocation({
      runId: 'run-1',
      toolId: 'git-safe',
      toolVersion: '2.0.0',
      input: { repositoryPath: '/repo', action: 'status' },
    });

    expect(first.version).toBe(TOOL_INVOCATION_VERSION);
    expect(first.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.inputHash).toBe(first.inputHash);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.risk).toBe('read');
    expect(validateToolInvocation(first)).toEqual({ valid: true, errors: [] });
  });

  test.each([
    ['remote read-only inspection', 'read', {
      toolId: 'remote-command',
      input: { command: 'hostname && whoami && uname -m && uptime' },
    }],
    ['destructive remote command', 'destructive', {
      toolId: 'remote-command',
      input: { command: 'rm -rf /srv/old-app' },
    }],
    ['git status', 'read', {
      toolId: 'git-safe',
      input: { command: 'git status --short' },
    }],
    ['git commit', 'write', {
      toolId: 'git-safe',
      input: { command: 'git commit -m evidence' },
    }],
    ['git push', 'external', {
      toolId: 'git-safe',
      input: { command: 'git push origin feature' },
    }],
    ['git remote-info action', 'read', {
      toolId: 'git-safe',
      input: { action: 'remote-info' },
    }],
    ['deployment apply', 'external', {
      toolId: 'k3s-deploy',
      input: { action: 'apply', manifest: 'k8s/app.yaml' },
    }],
    ['deployment rollout-status action', 'read', {
      toolId: 'k3s-deploy',
      input: { action: 'rollout-status' },
    }],
    ['secret inspection', 'external', {
      toolId: 'remote-command',
      input: { command: 'kubectl get secrets -A' },
    }],
    ['secret rotation', 'destructive', {
      toolId: 'remote-command',
      input: { action: 'rotate secret', name: 'api-key' },
    }],
  ])('classifies %s as %s', (_label, expected, options) => {
    expect(inferToolInvocationRisk(options)).toBe(expected);
  });

  test('carries verified evidence and recursively redacts structured result data', () => {
    const evidence = createEvidenceAttestation({
      kind: 'command',
      subject: 'node --check src/tool-invocation.js',
      sourceInvocationId: 'invocation-check',
      observedAt: '2026-07-09T12:00:00.000Z',
      verdict: 'pass',
      details: { exitCode: 0 },
    });
    const invocation = createToolInvocation({
      id: 'invocation-check',
      runId: 'run-2',
      toolId: 'remote-command',
      input: { command: 'node --check src/tool-invocation.js' },
      status: 'succeeded',
      result: {
        stdout: 'ok',
        nested: { accessToken: 'top-secret-token' },
      },
      evidence: [evidence],
      sideEffects: [{ type: 'execute', resource: '/repo' }],
    });

    expect(invocation.result.nested.accessToken).toBe('[REDACTED]');
    expect(invocation.evidence).toEqual([evidence]);
    expect(invocation.sideEffects).toHaveLength(1);
    expect(validateToolInvocation(invocation).valid).toBe(true);
  });

  test('rejects an input hash that does not match structured parameters', () => {
    expect(() => createToolInvocation({
      runId: 'run-3',
      toolId: 'git-safe',
      input: { action: 'status' },
      inputHash: 'a'.repeat(64),
    })).toThrow('does not match');
  });

  test('allows reads and bounded sandbox writes without approval', () => {
    const read = createToolInvocation({ runId: 'run-policy', toolId: 'git-safe', input: { action: 'status' } });
    const write = createToolInvocation({ runId: 'run-policy', toolId: 'code-sandbox', input: { action: 'write' } });

    expect(decideToolInvocationApproval(read).mode).toBe('automatic-read');
    expect(decideToolInvocationApproval(write, { sandboxMode: true, workspaceBounded: true })).toEqual(expect.objectContaining({
      allowed: true,
      mode: 'bounded-sandbox-write',
    }));
  });

  test('requires an exact scoped receipt for external and destructive actions', () => {
    const invocation = createToolInvocation({
      runId: 'run-policy',
      toolId: 'git-safe',
      input: { command: 'git push origin main' },
    });
    const denied = decideToolInvocationApproval(invocation, {
      approvalReceipt: { id: 'approval-wrong', status: 'approved', scope: 'remote-command' },
    });
    const selfIssued = decideToolInvocationApproval(invocation, {
      approvalReceipt: {
        version: 'ApprovalReceipt/v1',
        id: 'self-issued',
        status: 'approved',
        scope: 'git-safe:external',
        runId: invocation.runId,
        toolId: invocation.toolId,
        risk: invocation.risk,
        inputHash: invocation.inputHash,
        grantedBy: 'attacker',
        grantedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const receipt = issueApprovalReceipt({
      id: 'approval-push',
      scope: 'git-safe:external',
      runId: invocation.runId,
      toolId: invocation.toolId,
      risk: invocation.risk,
      inputHash: invocation.inputHash,
      grantedBy: 'tester',
    });
    const allowed = decideToolInvocationApproval(invocation, {
      approvalReceipt: receipt,
    });

    expect(denied.allowed).toBe(false);
    expect(selfIssued.allowed).toBe(false);
    expect(allowed).toEqual(expect.objectContaining({
      allowed: true,
      mode: 'scoped-approval',
      receipt: expect.objectContaining({ id: 'approval-push' }),
    }));
  });

  test('marks writes retry-safe only when explicitly declared idempotent', () => {
    const unsafe = createToolInvocation({ runId: 'run-retry', toolId: 'git-safe', input: { action: 'commit' } });
    const safe = createToolInvocation({
      runId: 'run-retry',
      toolId: 'git-safe',
      input: { action: 'commit' },
      idempotency: { safeToRetry: true },
    });

    expect(unsafe.retrySafe).toBe(false);
    expect(safe.retrySafe).toBe(true);
  });
});

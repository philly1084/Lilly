'use strict';

const { ToolBase } = require('./ToolBase');
const { createToolInvocation, issueApprovalReceipt } = require('../../tool-invocation');

describe('ToolBase output contracts', () => {
  test('rejects missing required output properties', async () => {
    const tool = new ToolBase({
      id: 'structured-output',
      backend: {
        handler: async () => ({ count: 1 }),
      },
      outputSchema: {
        type: 'object',
        required: ['name', 'count'],
        properties: {
          name: { type: 'string' },
          count: { type: 'integer' },
        },
      },
    });

    const result = await tool.execute({});

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'TOOL_OUTPUT_SCHEMA_VALIDATION_FAILED',
      errorType: 'ToolOutputValidationError',
    }));
    expect(result.error).toContain('result.name');
  });

  test('rejects invalid nested output types and accepts valid arrays', async () => {
    const invalidTool = new ToolBase({
      id: 'nested-output-invalid',
      backend: {
        handler: async () => ({ rows: [{ id: 'not-an-integer' }] }),
      },
      outputSchema: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'integer' } },
            },
          },
        },
      },
    });
    const validTool = new ToolBase({
      id: 'nested-output-valid',
      backend: {
        handler: async () => ({ rows: [{ id: 1 }] }),
      },
      outputSchema: invalidTool.outputSchema,
    });

    const invalid = await invalidTool.execute({});
    const valid = await validTool.execute({});

    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain('result.rows[0].id');
    expect(valid).toEqual(expect.objectContaining({
      success: true,
      data: { rows: [{ id: 1 }] },
    }));
  });

  test('preserves tools that do not declare an output schema', async () => {
    const tool = new ToolBase({
      id: 'legacy-string-output',
      backend: {
        handler: async () => 'legacy output',
      },
    });

    await expect(tool.execute({})).resolves.toEqual(expect.objectContaining({
      success: true,
      data: 'legacy output',
    }));
    expect(tool.outputSchema).toBeNull();
  });

  test('isolates side effects for every invocation', async () => {
    const tool = new ToolBase({
      id: 'isolated-effects',
      backend: {
        handler: async (params, _context, tracker) => {
          tracker.recordRead(params.resource);
          return { resource: params.resource };
        },
      },
      outputSchema: {
        type: 'object',
        required: ['resource'],
        properties: { resource: { type: 'string' } },
      },
    });

    const first = await tool.execute({ resource: 'first.txt' });
    const second = await tool.execute({ resource: 'second.txt' });

    expect(first.sideEffects.reads).toHaveLength(1);
    expect(first.sideEffects.reads[0].resource).toBe('first.txt');
    expect(second.sideEffects.reads).toHaveLength(1);
    expect(second.sideEffects.reads[0].resource).toBe('second.txt');
  });

  test('isolates the legacy tracker property across concurrent invocations', async () => {
    class PropertyTrackerTool extends ToolBase {
      async executeWithTimeout(params, context) {
        await new Promise((resolve) => setTimeout(resolve, params.handlerDelay));
        return this.handler(params, context, this.sideEffectTracker);
      }
    }
    const tool = new PropertyTrackerTool({
      id: 'concurrent-side-effects',
      hooks: {
        beforeExecute: (params) => new Promise((resolve) => setTimeout(resolve, params.beforeDelay)),
      },
      backend: {
        handler: async (params, _context, tracker) => {
          tracker.recordRead(params.resource);
          return { resource: params.resource };
        },
      },
    });

    const [first, second] = await Promise.all([
      tool.execute({ resource: 'first.txt', beforeDelay: 15, handlerDelay: 5 }),
      tool.execute({ resource: 'second.txt', beforeDelay: 0, handlerDelay: 20 }),
    ]);

    expect(first.sideEffects.reads.map((effect) => effect.resource)).toEqual(['first.txt']);
    expect(second.sideEffects.reads.map((effect) => effect.resource)).toEqual(['second.txt']);
  });

  test('emits ToolInvocation/v2 when a canonical run id is present', async () => {
    const tool = new ToolBase({
      id: 'inspect-status',
      backend: {
        handler: async () => ({ status: 'ready' }),
        sideEffects: ['read'],
      },
    });

    const result = await tool.execute({ action: 'status' }, { runId: 'agent-run-1' });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      invocation: expect.objectContaining({
        version: 'ToolInvocation/v2',
        runId: 'agent-run-1',
        toolId: 'inspect-status',
        risk: 'read',
        retrySafe: true,
        status: 'succeeded',
      }),
      approvalDecision: expect.objectContaining({ allowed: true, mode: 'automatic-read' }),
    }));
  });

  test('blocks an external invocation when policy enforcement lacks a scoped receipt', async () => {
    const handler = jest.fn(async () => ({ pushed: true }));
    const tool = new ToolBase({
      id: 'git-safe',
      backend: { handler, sideEffects: ['write', 'network'] },
    });

    const result = await tool.execute({ command: 'git push origin main' }, {
      runId: 'agent-run-2',
      enforceToolInvocationPolicy: true,
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'TOOL_APPROVAL_REQUIRED',
      invocation: expect.objectContaining({ risk: 'external', status: 'blocked' }),
    }));
    expect(handler).not.toHaveBeenCalled();
  });

  test('enforces Mission Mode by default and accepts only a signed exact receipt', async () => {
    const handler = jest.fn(async () => ({ pushed: true }));
    const tool = new ToolBase({
      id: 'git-safe',
      backend: { handler, sideEffects: ['write', 'network'] },
    });
    const params = { command: 'git push origin main' };
    const planned = createToolInvocation({ runId: 'agent-run-mission', toolId: 'git-safe', input: params });
    const signedReceipt = issueApprovalReceipt({
      runId: planned.runId,
      toolId: planned.toolId,
      risk: planned.risk,
      inputHash: planned.inputHash,
      scope: `${planned.toolId}:${planned.risk}`,
      grantedBy: 'mission-owner',
    });

    const blocked = await tool.execute(params, {
      runId: planned.runId,
      metadata: { missionMode: true },
    });
    const allowed = await tool.execute(params, {
      runId: planned.runId,
      metadata: { missionMode: true, approvalReceipts: [signedReceipt] },
    });

    expect(blocked).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'TOOL_APPROVAL_REQUIRED',
    }));
    expect(allowed).toEqual(expect.objectContaining({
      success: true,
      approvalDecision: expect.objectContaining({ mode: 'scoped-approval' }),
    }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('allows a bounded sandbox write without an approval receipt', async () => {
    const tool = new ToolBase({
      id: 'code-sandbox',
      backend: { handler: async () => ({ written: true }), sideEffects: ['write'] },
    });

    const result = await tool.execute({ action: 'write', path: 'index.html' }, {
      runId: 'agent-run-3',
      enforceToolInvocationPolicy: true,
      sandboxMode: true,
      workspaceBounded: true,
    });

    expect(result.success).toBe(true);
    expect(result.approvalDecision.mode).toBe('bounded-sandbox-write');
  });
});

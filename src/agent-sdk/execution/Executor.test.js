const { Executor } = require('./Executor');
const { ExecutionPlan } = require('./Planner');
const { ToolDefinition } = require('../tools/ToolDefinition');
const { ToolRegistry } = require('../tools/ToolRegistry');
const { WorkingMemory } = require('../memory/WorkingMemory');
const { Verifier } = require('./Verifier');

function createTask(overrides = {}) {
  return {
    id: 'task-1',
    type: 'chat',
    objective: 'Run the planned tool.',
    completionCriteria: {
      conditions: [],
    },
    transitionStatus(status) {
      this.status = status;
    },
    ...overrides,
  };
}

function createExecutorWithPlan(plan, toolRegistry) {
  return new Executor({
    toolRegistry,
    workingMemory: null,
    retryEngine: null,
    verifier: {
      verify: jest.fn(async () => ({
        valid: true,
        passed: 0,
        total: 0,
        results: [],
      })),
    },
    planner: {
      createPlan: jest.fn(async () => plan),
    },
    llmClient: {
      complete: jest.fn(),
    },
  });
}

describe('Executor tool failure handling', () => {
  test('reports an unconfigured completion check without rerunning successful work', async () => {
    const plan = new ExecutionPlan('task-1');
    plan.addStep({ type: 'llm-call', description: 'Draft the final answer', prompt: 'Summarize the result.' });
    const executor = createExecutorWithPlan(plan, new ToolRegistry());
    executor.verifier = new Verifier();
    executor.llmClient.complete.mockResolvedValue('I completed the task.');
    const task = createTask({
      completionCriteria: {
        conditions: [{ type: 'custom-check', check: 'artifact-readable', expected: true }],
      },
      canRetry: jest.fn(() => true),
      incrementAttempt: jest.fn(),
    });

    const result = await executor.execute(task);

    expect(result.success).toBe(false);
    expect(result.completionStatus).toBe('unverified');
    expect(result.nextActions).toEqual(['configure_custom_check']);
    expect(result.output).toBe('I completed the task.');
    expect(task.status).toBe('failed');
    expect(task.canRetry).not.toHaveBeenCalled();
    expect(task.incrementAttempt).not.toHaveBeenCalled();
    expect(executor.llmClient.complete).toHaveBeenCalledTimes(1);
  });

  test('treats a failed tool execution result as a failed step', async () => {
    const plan = new ExecutionPlan('task-1');
    plan.addStep({
      type: 'tool-call',
      description: 'Call a failing tool',
      tool: 'failing-tool',
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new ToolDefinition({
      id: 'failing-tool',
      name: 'Failing Tool',
      description: 'Returns an execution failure',
      handler: async () => {
        throw new Error('upstream service unavailable');
      },
    }));

    const executor = createExecutorWithPlan(plan, toolRegistry);
    const result = await executor.execute(createTask());

    expect(result.success).toBe(false);
    expect(result.error).toContain('upstream service unavailable');
    expect(result.trace.metrics.errors).toBe(1);
    expect(result.trace.steps[0]).toEqual(expect.objectContaining({
      type: 'tool-call',
      error: 'upstream service unavailable',
    }));
    expect(result.plan.progress.failed).toBe(1);
  });

  test('skips optional failed tool steps and continues the plan', async () => {
    const plan = new ExecutionPlan('task-1');
    plan.addStep({
      type: 'tool-call',
      description: 'Call an optional failing tool',
      tool: 'optional-tool',
      optional: true,
    });
    plan.addStep({
      type: 'llm-call',
      description: 'Draft the final answer',
      prompt: 'Summarize the result.',
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new ToolDefinition({
      id: 'optional-tool',
      name: 'Optional Tool',
      description: 'Fails but is optional',
      handler: async () => {
        throw new Error('optional source offline');
      },
    }));

    const executor = createExecutorWithPlan(plan, toolRegistry);
    executor.llmClient.complete.mockResolvedValue('Final answer without optional source.');

    const result = await executor.execute(createTask());

    expect(result.success).toBe(true);
    expect(result.output).toBe('Final answer without optional source.');
    expect(result.plan.progress.completed).toBe(1);
    expect(result.plan.progress.failed).toBe(0);
    expect(result.trace.metrics.errors).toBe(1);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        success: false,
        error: 'optional source offline',
      }),
      expect.objectContaining({
        success: true,
        output: 'Final answer without optional source.',
      }),
    ]));
  });
});

describe('Executor working-memory handoffs', () => {
  test('passes earlier tool output to dependent tool parameters and the synthesis prompt', async () => {
    const plan = new ExecutionPlan('task-1');
    const lookupStep = plan.addStep({
      type: 'tool-call',
      tool: 'lookup-status',
      resultKey: 'status',
    });
    const summarizeStep = plan.addStep({
      type: 'tool-call',
      tool: 'summarize-status',
      params: {
        status: '{{results.status}}',
        values: ['{{results.status.count}}', '{{results.status.ready}}'],
        nested: { target: `{{steps.${lookupStep}.output.target}}` },
      },
      resultKey: 'summary',
    }, [lookupStep]);
    plan.addStep({
      type: 'llm-call',
      prompt: 'Request: {{currentTask.objective}}\nStatus: {{results.summary}}',
    }, [summarizeStep]);

    const status = { target: 'cluster-a', count: 0, ready: false };
    const toolRegistry = {
      execute: jest.fn(async (toolId) => ({
        success: true,
        result: toolId === 'lookup-status' ? status : 'No workers are ready.',
      })),
    };
    const executor = createExecutorWithPlan(plan, toolRegistry);
    executor.workingMemory = new WorkingMemory('handoff-session');
    const task = createTask({ objective: 'Check cluster-a readiness.' });
    executor.workingMemory.setCurrentTask(task);
    executor.llmClient.complete.mockResolvedValue('Cluster A has no ready workers.');

    const result = await executor.execute(task);

    expect(result.success).toBe(true);
    expect(toolRegistry.execute.mock.calls[1][0]).toBe('summarize-status');
    expect(toolRegistry.execute.mock.calls[1][1]).toEqual({
      status,
      values: [0, false],
      nested: { target: 'cluster-a' },
    });
    expect(executor.llmClient.complete).toHaveBeenCalledWith(
      'Request: Check cluster-a readiness.\nStatus: No workers are ready.',
      expect.any(Object),
    );
  });

  test.each([undefined, null, {}])('falls back when a task intermediate is %p', (results) => {
    const executor = createExecutorWithPlan(null, null);
    executor.workingMemory = new WorkingMemory('fallback-session');
    executor.workingMemory.setIntermediateResult('results', { status: { count: 0 } });

    expect(executor.resolveParams({ count: '{{results.status.count}}' }, { results }))
      .toEqual({ count: 0 });
  });

  test.each([0, false, '', null, { count: 2 }])('preserves an explicit task value of %p', (status) => {
    const executor = createExecutorWithPlan(null, null);
    executor.workingMemory = new WorkingMemory('precedence-session');
    executor.workingMemory.setIntermediateResult('results', { status: 'memory fallback' });

    expect(executor.resolveTemplateString('{{results.status}}', { results: { status } }))
      .toEqual(status);
  });

  test('keeps unresolved references empty in prose and undefined in structured parameters', () => {
    const executor = createExecutorWithPlan(null, null);
    const params = { exact: '{{missing.nested.value}}', prose: 'Value: {{missing.nested.value}}' };

    expect(executor.resolveParams(params, createTask())).toEqual({ exact: undefined, prose: 'Value: ' });
    executor.workingMemory = new WorkingMemory('missing-session');
    expect(executor.resolveParams(params, createTask())).toEqual({ exact: undefined, prose: 'Value: ' });
  });
});

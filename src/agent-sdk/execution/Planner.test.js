const { Planner, ExecutionPlan } = require('./Planner');

test('explicitly skipped optional steps release dependents but failed steps do not', () => {
  const plan = new ExecutionPlan('recovery');
  const first = plan.addStep({ type: 'tool-call', optional: true });
  const retry = plan.addStep({ type: 'tool-call' }, [first]);
  plan.markStepFailed(first, new Error('temporary failure'));
  expect(plan.getReadySteps()).toEqual([]);
  plan.skipStep(first, 'continue to planned recovery');
  expect(plan.getReadySteps().map((step) => step.id)).toEqual([retry]);
});

describe('Planner', () => {
  test('conversation synthesis prompt includes the skill context placeholder', () => {
    const planner = new Planner(null, null);

    expect(planner.buildConversationSynthesisPrompt()).toContain('{{skillContext}}');
  });

  test('conversation planning prompt includes explicit quota guidance', () => {
    const planner = new Planner(null, null, {
      planningLimits: {
        maxSteps: 6,
        maxEstimatedTokens: 5000,
        maxConsecutiveToolCalls: 2,
      },
    });

    const prompt = planner.buildConversationPlanningPrompt(
      { objective: 'Research and implement a fix.' },
      ['web-search'],
      { maxSteps: 4, maxEstimatedTokens: 3500, maxConsecutiveToolCalls: 1 },
    );

    expect(prompt).toContain('Plan quota: max 4 steps, max 3500 estimated tokens total.');
    expect(prompt).toContain('Avoid more than 1 consecutive tool-call steps');
  });

  test('conversation planning prompt includes relevant skill context', () => {
    const planner = new Planner(null, null);

    const prompt = planner.buildConversationPlanningPrompt(
      {
        objective: 'Generate images and deploy the website.',
        skillContext: '<registered_skills><skill>id=image-website-k3s</skill></registered_skills>',
      },
      ['image-generate', 'remote-cli-agent'],
    );

    expect(prompt).toContain('Relevant skills:');
    expect(prompt).toContain('image-website-k3s');
    expect(prompt).toContain('Still use only the listed tools');
  });

  test('parses annotated lenient JSON conversation plans', () => {
    const planner = new Planner(null, null);

    const plan = planner.parseConversationPlan('```json title="conversation plan" source="planner"\n{steps:[{type:"tool-call", tool:"web-search", description:"Find references", estimatedTokens:900,},]}\n```');

    expect(plan).toEqual({
      steps: [
        {
          type: 'tool-call',
          tool: 'web-search',
          description: 'Find references',
          estimatedTokens: 900,
        },
      ],
    });
  });

  test('repairs malformed planning output once with explicit schema feedback', async () => {
    const client = { complete: jest.fn().mockResolvedValueOnce('I will do it.').mockResolvedValueOnce('{"steps":[{"type":"tool-call","tool":"file-read","params":{"path":"report.md"}}]}') };
    const planner = new Planner(null, client);
    const steps = await planner.createConversationStepsFromModel({ objective: 'Read report.md' }, ['file-read']);
    expect(steps[0].tool).toBe('file-read');
    expect(client.complete.mock.calls[1][0]).toContain('previous plan could not be parsed');
    expect(client.complete.mock.calls[0][1].role).toBe('planner');
  });

  test('normalizes and constrains conversation plans by quota and follow-through checkpoints', () => {
    const planner = new Planner(null, null, {
      planningLimits: {
        maxSteps: 10,
        maxEstimatedTokens: 5000,
        maxTokensPerStep: 1000,
        maxConsecutiveToolCalls: 2,
      },
    });

    const steps = planner.normalizeConversationSteps({
      steps: [
        { type: 'tool-call', tool: 'web-search', description: 'Find references', estimatedTokens: 1800 },
        { type: 'tool-call', tool: 'web-search', description: 'Collect examples', estimatedTokens: 1800 },
        { type: 'tool-call', tool: 'web-search', description: 'Collect more examples', estimatedTokens: 900 },
        { type: 'llm-call', description: 'Draft response', estimatedTokens: 900 },
      ],
    }, ['web-search'], {
      maxSteps: 5,
      maxEstimatedTokens: 2600,
      maxTokensPerStep: 1000,
      maxConsecutiveToolCalls: 2,
    });

    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual(expect.objectContaining({
      type: 'tool-call',
      estimatedTokens: 1000,
    }));
    expect(steps[1]).toEqual(expect.objectContaining({
      type: 'tool-call',
      estimatedTokens: 1000,
    }));
    expect(steps[2]).toEqual(expect.objectContaining({
      type: 'llm-call',
      description: 'Summarize interim progress before continuing',
      estimatedTokens: 400,
    }));
  });
});

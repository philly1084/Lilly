'use strict';

const { buildModelRoutingShadow } = require('./model-routing-shadow');

describe('model routing shadow', () => {
  test('respects manual-only policy when proposing an automatic route', () => {
    const decision = buildModelRoutingShadow({
      models: [
        { id: 'gpt-6-astra', autoEligible: false },
        { id: 'custom-tools-router', capabilities: ['chat', 'tools'] },
      ],
      currentModel: 'custom-tools-router',
      request: { needsTools: true },
    });

    expect(decision.proposedModel).toBe('custom-tools-router');
    expect(decision.changed).toBe(false);
    expect(decision.applied).toBe(false);
  });

  test('leaves the proposal empty when every capable model is manual-only', () => {
    const decision = buildModelRoutingShadow({
      models: [{ id: 'gpt-6-astra', autoEligible: false }],
      currentModel: 'gpt-6-astra',
      request: { needsTools: true },
    });

    expect(decision.currentModel).toBe('gpt-6-astra');
    expect(decision.proposedModel).toBeNull();
    expect(decision.changed).toBe(false);
    expect(decision.applied).toBe(false);
  });

  test('proposes a capable model without changing production routing', () => {
    const decision = buildModelRoutingShadow({
      models: [
        { id: 'text-basic', capabilities: ['chat'] },
        { id: 'gpt-5.4', capabilities: ['chat', 'tools', 'reasoning'] },
      ],
      currentModel: 'text-basic',
      role: 'planner',
      request: { needsTools: true, needsReasoning: true },
    });

    expect(decision).toEqual(expect.objectContaining({
      schemaVersion: 'ModelRoutingShadow/v1',
      mode: 'shadow',
      currentModel: 'text-basic',
      proposedModel: 'gpt-5.4',
      changed: true,
      applied: false,
    }));
    expect(decision.requiredCapabilities).toEqual(expect.arrayContaining(['chat', 'tools', 'reasoning']));
  });

  test('reports no proposal when candidates cannot satisfy requirements', () => {
    const decision = buildModelRoutingShadow({
      models: [{ id: 'text-basic', capabilities: ['chat'] }],
      request: { needsVision: true },
    });
    expect(decision.proposedModel).toBeNull();
    expect(decision.applied).toBe(false);
  });
});

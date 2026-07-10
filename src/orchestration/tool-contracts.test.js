'use strict';

const {
  buildToolContract,
  classifyToolRisk,
} = require('./tool-contracts');

describe('tool contracts', () => {
  test('publishes ToolInvocation/v2 risk and output contract metadata', () => {
    const outputSchema = {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string' } },
    };
    const contract = buildToolContract('k3s-deploy', {
      version: '3.0.0',
      outputSchema,
      backend: { sideEffects: ['network', 'write'] },
    });

    expect(contract).toEqual(expect.objectContaining({
      toolVersion: '3.0.0',
      outputSchema,
      risk: 'external',
      riskModel: 'ToolInvocation/v2',
    }));
  });

  test('uses action-aware risk instead of a static remote-tool label', () => {
    expect(classifyToolRisk('remote-command', {
      command: 'kubectl get pods -A -o wide',
    })).toBe('read');
    expect(classifyToolRisk('remote-command', {
      command: 'kubectl delete namespace production',
    })).toBe('destructive');
    expect(classifyToolRisk('git-safe', {
      command: 'git push origin feature',
    })).toBe('external');
  });
});

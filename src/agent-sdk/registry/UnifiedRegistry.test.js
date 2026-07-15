const { UnifiedRegistry } = require('./UnifiedRegistry');

describe('UnifiedRegistry invocation stats', () => {
  test('records usage history and computed skill stats', () => {
    const registry = new UnifiedRegistry();

    registry.register({
      id: 'web-search',
      name: 'Web Search',
      description: 'Search the web',
      category: 'web',
      backend: {
        handler: async () => ({}),
      },
    });

    registry.recordInvocation('web-search', {
      success: true,
      duration: 125,
      timestamp: '2026-03-22T10:00:00.000Z',
    }, {
      sessionId: 'session-1',
      route: '/v1/chat/completions',
      executionProfile: 'default',
      model: 'gpt-4o',
      params: { query: 'test query', limit: 5 },
    });

    const skill = registry.getAllSkills().find((entry) => entry.id === 'web-search');

    expect(skill).toBeTruthy();
    expect(skill.usageCount).toBe(1);
    expect(skill.successRate).toBe(100);
    expect(skill.avgDuration).toBe(125);
    expect(skill.stats.byRoute['/v1/chat/completions']).toBe(1);
    expect(skill.stats.byExecutionProfile.default).toBe(1);
    expect(skill.stats.byModel['gpt-4o']).toBe(1);
    expect(skill.stats.recentUsage).toEqual([
      expect.objectContaining({
        toolId: 'web-search',
        sessionId: 'session-1',
        route: '/v1/chat/completions',
        executionProfile: 'default',
        model: 'gpt-4o',
        paramKeys: ['limit', 'query'],
        success: true,
      }),
    ]);
  });

  test('records serialized false tool results as failures', () => {
    const registry = new UnifiedRegistry();

    registry.register({
      id: 'web-fetch',
      name: 'Web Fetch',
      description: 'Fetch a web page',
      category: 'web',
      backend: {
        handler: async () => ({}),
      },
    });

    registry.recordInvocation('web-fetch', {
      success: 'false',
      error: 'Source request was denied',
      duration: 80,
    });

    expect(registry.getStats('web-fetch')).toEqual(expect.objectContaining({
      invocations: 1,
      successes: 0,
      failures: 1,
      successRate: 0,
      recentUsage: [
        expect.objectContaining({
          success: false,
          error: 'Source request was denied',
        }),
      ],
    }));
  });

  test('derives normalized trigger patterns and confirmation from tool metadata', () => {
    const registry = new UnifiedRegistry();

    registry.register({
      id: 'file-write',
      name: 'File Writer',
      description: 'Write file contents',
      category: 'system',
      backend: {
        handler: async () => ({}),
        sideEffects: ['write'],
      },
    });

    const skill = registry.getSkill('file-write');

    expect(skill.triggerPatterns).toEqual(expect.arrayContaining([
      'file writer',
      'file write',
    ]));
    expect(skill.requiresConfirmation).toBe(true);
  });

  test('keeps read-only tools confirmation-free by default', () => {
    const registry = new UnifiedRegistry();

    registry.register({
      id: 'file-read',
      name: 'File Reader',
      description: 'Read file contents',
      category: 'system',
      backend: {
        handler: async () => ({}),
        sideEffects: ['read'],
      },
    });

    const skill = registry.getSkill('file-read');

    expect(skill.triggerPatterns).toEqual(expect.arrayContaining([
      'file reader',
      'file read',
    ]));
    expect(skill.requiresConfirmation).toBe(false);
  });
});

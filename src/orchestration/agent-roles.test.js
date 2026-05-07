const {
  IMPRESSIVE_FRONTEND_QUALITY_BAR,
  hasWebsiteBuildIntent,
  inferAgentRolePipeline,
} = require('./agent-roles');

describe('agent role frontend sandbox detection', () => {
  test('treats browser games and Vite previews as sandbox frontend builds', () => {
    expect(hasWebsiteBuildIntent('Build a playable browser game with a Vite preview')).toBe(true);
    expect(hasWebsiteBuildIntent('Make me a video game about collecting blocks')).toBe(true);
    expect(hasWebsiteBuildIntent('Make a multi-step frontend sandbox for onboarding')).toBe(true);

    const pipeline = inferAgentRolePipeline({
      objective: 'Build a web game in the sandbox with restart controls',
    });

    expect(pipeline.requiresSandbox).toBe(true);
    expect(pipeline.sandboxPolicy).toEqual(expect.objectContaining({
      required: true,
      mode: 'project',
    }));
    expect(IMPRESSIVE_FRONTEND_QUALITY_BAR.appliesTo).toEqual(expect.arrayContaining([
      'browser-game',
      'vite-preview',
    ]));
  });

  test('treats natural concept-to-prototype requests as sandbox build journeys', () => {
    expect(hasWebsiteBuildIntent('I have an app idea, sandbox it locally before we deploy it with the remote CLI agent')).toBe(true);

    const pipeline = inferAgentRolePipeline({
      objective: 'Come up with a software idea, make a local sandbox prototype, then later deploy it through the remote CLI agent and save the repo work.',
    });

    expect(pipeline).toEqual(expect.objectContaining({
      strategy: 'concept-design-sandbox-build',
      requiresDesign: true,
      requiresBuild: true,
      requiresSandbox: true,
    }));
    expect(pipeline.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Builder Agent',
        outputContract: expect.objectContaining({
          format: 'sandbox-project',
        }),
      }),
    ]));
  });
});

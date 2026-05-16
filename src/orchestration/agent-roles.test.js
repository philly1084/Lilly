const {
  IMPRESSIVE_FRONTEND_QUALITY_BAR,
  formatFrontendQualityBarForPrompt,
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
    expect(pipeline.placeholderAssetPolicy).toEqual(expect.objectContaining({
      promptTag: 'game_placeholder_asset_policy',
    }));
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

  test('formats the canonical frontend quality bar for prompt surfaces', () => {
    const promptText = formatFrontendQualityBarForPrompt({
      includeCanvasHandoff: true,
      includeGameAddendum: true,
    });

    expect(promptText).toContain('<impressive_frontend_website_standard>');
    expect(promptText).toContain('first viewport must communicate the product');
    expect(promptText).toContain('Build the interaction model from the user workflow');
    expect(promptText).toContain('visual assets that reveal the actual product');
    expect(promptText).toContain('<sandbox_frontend_technology_ladder>');
    expect(promptText).toContain('React/Vite modules');
    expect(promptText).toContain('/api/sandbox-libraries/three/three.module.js');
    expect(promptText).toContain('<local_to_live_build_stages>');
    expect(promptText).toContain('managed-app iterate');
    expect(promptText).toContain('desktop and mobile screenshots');
    expect(promptText).toContain('iteration pass after the first render');
    expect(promptText).toContain('metadata.handoff');
    expect(promptText).toContain('<frontend_agent_build_workbench>');
    expect(promptText).toContain('Unity-like mental model');
    expect(promptText).toContain('metadata.handoff.buildWorkbench');
    expect(promptText).toContain('scripts/functions');
    expect(promptText).toContain('<frontend_repair_redesign_gate>');
    expect(promptText).toContain('repair, redesign, ask, or ready');
    expect(promptText).toContain('<game_placeholder_asset_policy>');
    expect(promptText).toContain('varied silhouettes');
    expect(promptText).toContain('nonblank render verification');
  });
});

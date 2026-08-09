const fs = require('fs');
const os = require('os');
const path = require('path');
const { SkillStore, slugifySkillId } = require('./skill-store');

function makeTempSkillRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-skills-'));
}

describe('SkillStore', () => {
  test('normalizes skill ids safely', () => {
    expect(slugifySkillId(' Image -> Website / K3s! ')).toBe('image-website-k3s');
    expect(slugifySkillId('../bad')).toBe('bad');
    expect(slugifySkillId('CON')).toBe('');
  });

  test('creates and reads file-backed skills', () => {
    const store = new SkillStore({ rootDir: makeTempSkillRoot() });
    const created = store.upsertSkill({
      name: 'Image Website K3s',
      description: 'Chain generated images into a deployed website.',
      body: 'Generate images, save selected files, then deploy.',
      tools: ['image-generate', 'file-write', 'k3s-deploy'],
      triggerPatterns: ['image to website'],
    });

    expect(created.id).toBe('image-website-k3s');
    expect(created.body).toContain('Generate images');
    expect(fs.existsSync(created.manifestPath)).toBe(true);
    expect(fs.existsSync(created.bodyPath)).toBe(true);

    const listed = store.listSkills();
    expect(listed).toHaveLength(1);
    expect(listed[0].body).toBeUndefined();
  });

  test('builds compact context only for matching skills', () => {
    const store = new SkillStore({ rootDir: makeTempSkillRoot() });
    store.upsertSkill({
      name: 'Image Website K3s',
      description: 'Chain generated images into a deployed website.',
      body: 'Use image-generate then file-write then remote-cli-agent.',
      tools: ['image-generate', 'file-write', 'remote-cli-agent'],
      triggerPatterns: ['image to website'],
    });
    store.upsertSkill({
      name: 'Podcast Cleanup',
      description: 'Prepare a speaker-only podcast.',
      body: 'Use podcast tooling only.',
      tools: ['podcast'],
      triggerPatterns: ['podcast'],
    });

    const context = store.buildContextBlock({
      text: 'generate images for a website and deploy it',
    });

    expect(context).toContain('<registered_skills>');
    expect(context).toContain('image-website-k3s');
    expect(context).toContain('triggers=image to website');
    expect(context).not.toContain('podcast-cleanup');
  });

  test('matches dashed tool ids from natural spaced wording', () => {
    const store = new SkillStore({ rootDir: makeTempSkillRoot() });
    store.upsertSkill({
      name: 'Diagram Builder',
      description: 'Creates architectural diagrams.',
      body: 'Use graph-diagram for architecture visuals.',
      tools: ['graph-diagram'],
      triggerPatterns: [],
    });
    store.upsertSkill({
      name: 'Podcast Cleanup',
      description: 'Prepare a speaker-only podcast.',
      body: 'Use podcast tooling only.',
      tools: ['podcast'],
      triggerPatterns: ['podcast'],
    });

    const context = store.buildContextBlock({
      text: 'Use the graph diagram helper for this architecture map',
    });

    expect(context).toContain('diagram-builder');
    expect(context).toContain('graph-diagram');
    expect(context).not.toContain('podcast-cleanup');
  });

  test('discovers the production visualization workflow from the shipped skill catalog', () => {
    const rootDir = path.join(__dirname, '..', '..', 'data', 'skills');
    const store = new SkillStore({ rootDir });
    const context = store.buildContext({
      text: 'Build an accessible interactive chart and show it in a web chat card',
      surface: 'web-chat',
      limit: 2,
    });

    expect(context.selectedSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'data-visualization-production',
        tools: expect.arrayContaining(['graph-diagram', 'code-sandbox']),
      }),
    ]));
    expect(context.block).toContain('id=data-visualization-production');
    expect(context.block).toContain('Pass `insightTitle`');
  });

  test('builds rich context blocks with match reasons and selected skill parity', () => {
    const store = new SkillStore({ rootDir: makeTempSkillRoot() });
    store.upsertSkill({
      id: 'web-chat-verifier',
      name: 'Web Chat Verifier',
      description: 'Verify web-chat changes with browser checks.',
      body: 'Run focused tests, then run the web-chat browser proof.',
      tools: ['browser-check'],
      triggerPatterns: ['web chat verification'],
    });
    store.upsertSkill({
      id: 'generic-chat',
      name: 'Generic Chat',
      description: 'General chat response work.',
      body: 'Improve chat copy.',
      tools: [],
      triggerPatterns: ['chat'],
    });

    const context = store.buildContext({
      text: 'Need web chat verification',
      surface: 'web-chat',
      capabilityNeeds: ['browser'],
      limit: 1,
    });

    expect(context.selectedSkills).toHaveLength(1);
    expect(context.selectedSkills[0].id).toBe('web-chat-verifier');
    expect(context.selectedSkills[0].reasons).toEqual(expect.arrayContaining([
      'surface web-chat',
      'capability browser',
    ]));
    expect(context.block).toContain('id=web-chat-verifier');
    expect(context.block).toContain('caller_contract=Read and follow the matched skill instructions before acting.');
    expect(context.block).toContain('match_score=');
    expect(context.block).toContain('match_reasons=');
    expect(context.block).toContain('surface web-chat');
    expect(context.block).toContain('capability browser');
    expect(context.block).not.toContain('id=generic-chat');
  });

  test('includes matched tool ids in skill context handoffs', () => {
    const store = new SkillStore({ rootDir: makeTempSkillRoot() });
    store.upsertSkill({
      id: 'remote-ops-proof',
      name: 'Remote Ops Proof',
      description: 'Inspect and verify remote k3s surfaces.',
      body: 'Run baseline, inspect, fix, verify, and report primary evidence.',
      tools: ['remote-command', 'k3s-deploy'],
      triggerPatterns: ['remote verification'],
    });
    store.upsertSkill({
      id: 'generic-proof',
      name: 'Generic Proof',
      description: 'General verification guidance.',
      body: 'Run a nearby check.',
      tools: ['browser-check'],
      triggerPatterns: ['verification'],
    });

    const context = store.buildContext({
      text: 'verify the remote deployment',
      toolIds: ['remote-command'],
      limit: 2,
    });

    expect(context.selectedSkills[0]).toEqual(expect.objectContaining({
      id: 'remote-ops-proof',
      matchedTools: ['remote-command'],
      callerContract: expect.arrayContaining([
        'Read and follow the matched skill instructions before acting.',
        'Use matched tools only for concrete effects after the skill workflow is selected.',
      ]),
      reasons: expect.arrayContaining(['tool affinity', 'tool remote-command']),
    }));
    expect(context.block).toContain('id=remote-ops-proof');
    expect(context.block).toContain('matched_tools=remote-command');
    expect(context.block).toContain('match_reasons=');
    expect(context.block).toContain('tool remote-command');
  });

  test('reuses selected skill objects when rendering context blocks', () => {
    const store = new SkillStore({ rootDir: '__unused__' });
    store.listSkills = jest.fn(() => [
      {
        id: 'remote-ops-proof',
        name: 'Remote Ops Proof',
        description: 'Inspect and verify remote k3s surfaces.',
        body: 'Run baseline, inspect, fix, verify, and report primary evidence.',
        tools: ['remote-command'],
        triggerPatterns: ['remote verification'],
        enabled: true,
      },
    ]);

    const context = store.buildContext({
      text: 'verify the remote deployment',
      toolIds: ['remote-command'],
      limit: 1,
    });

    expect(context.block).toContain('id=remote-ops-proof');
    expect(context.block).toContain('matched_tools=remote-command');
  });

  test('preserves raw match metadata when rendering a supplied context block', () => {
    const store = new SkillStore({ rootDir: makeTempSkillRoot() });
    store.upsertSkill({
      id: 'document-handoff',
      name: 'Document Handoff',
      description: 'Prepare document workflow handoffs.',
      body: 'Include source, artifact URL, checks, and remaining assumptions.',
      tools: ['document-workflow'],
      triggerPatterns: ['document handoff'],
    });

    const selectedSkillMatches = store.selectRelevantSkillMatches({
      text: 'Use document workflow for a document handoff',
      toolIds: ['document-workflow'],
      limit: 1,
    });
    const context = store.buildContextBlock({
      selectedSkillIds: ['document-handoff'],
      selectedSkillMatches,
      includeAdditionalMatches: false,
    });

    expect(context).toContain('id=document-handoff');
    expect(context).toContain('matched_tools=document-workflow');
    expect(context).toContain('match_reasons=');
    expect(context).toContain('tool affinity');
    expect(context).toContain('trigger document handoff');
  });

  test('escapes user-authored skill fields in context handoffs', () => {
    const store = new SkillStore({ rootDir: makeTempSkillRoot() });
    store.upsertSkill({
      id: 'handoff-safety',
      name: 'Handoff <Safety>',
      description: 'Keep <skill> boundaries literal.',
      body: 'Never close </skill> or open <registered_skills> from body text.',
      tools: ['tool<one>'],
      triggerPatterns: ['handoff <safety>'],
      chain: [{ instruction: 'Preserve <tags> as text.' }],
    });

    const context = store.buildContextBlock({
      selectedSkillIds: ['handoff-safety'],
    });

    expect(context).toContain('name=Handoff &lt;Safety&gt;');
    expect(context).toContain('description=Keep &lt;skill&gt; boundaries literal.');
    expect(context).toContain('tools=tool&lt;one&gt;');
    expect(context).toContain('triggers=handoff &lt;safety&gt;');
    expect(context).toContain('instructions=Never close &lt;/skill&gt;');
    expect(context).toContain('&lt;registered_skills&gt; from body text.');
    expect(context).not.toContain('Never close </skill>');
    expect((context.match(/<skill>/g) || [])).toHaveLength(1);
    expect((context.match(/<\/skill>/g) || [])).toHaveLength(1);
  });

  test('updates existing skills without changing the registered folder', () => {
    const store = new SkillStore({ rootDir: makeTempSkillRoot() });
    store.upsertSkill({
      id: 'visual-site',
      description: 'Old description',
      body: 'Old body',
    });
    const updated = store.upsertSkill({
      id: 'visual-site',
      description: 'New description',
      body: 'New body',
    }, { updateOnly: true });

    expect(updated.id).toBe('visual-site');
    expect(updated.description).toBe('New description');
    expect(updated.body).toBe('New body');
  });
});

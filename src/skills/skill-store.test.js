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

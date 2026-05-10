const {
  getPromptSurfaceInventory,
  getRequiredPromptSurfaceIds,
  renderPromptTemplate,
} = require('./prompt-renderer');

describe('prompt renderer', () => {
  test('renderPromptTemplate fails unknown variables and supports default/json filters', () => {
    expect(renderPromptTemplate('Issue {{ issue.identifier }} {{ issue.description | default: "none" }}', {
      issue: { identifier: 'KB-1', title: 'Add prompt inventory' },
    })).toBe('Issue KB-1 none');

    expect(renderPromptTemplate('{{ issue.labels | json }}', {
      issue: { labels: ['prompt', 'inventory'] },
    })).toBe('["prompt","inventory"]');

    expect(() => renderPromptTemplate('{{ issue.nope }}', {
      issue: { identifier: 'KB-1' },
    })).toThrow('Unknown template variable');

    expect(() => renderPromptTemplate('{{ issue.title | unknown }}', {
      issue: { title: 'Add prompt inventory' },
    })).toThrow('Unknown template filter');
  });

  test('inventory covers required prompt surfaces with owners and focused tests', () => {
    const inventory = getPromptSurfaceInventory();
    const ids = inventory.map((entry) => entry.id);

    expect(ids).toEqual(expect.arrayContaining(getRequiredPromptSurfaceIds()));
    expect(ids).toEqual(expect.arrayContaining([
      'chat-continuity',
      'conversation-planner',
      'canvas-generation',
      'notation-helper',
      'notes-page-editor',
      'remote-cli-agent',
      'tool-doc-guidance',
      'skill-guidance',
    ]));

    getRequiredPromptSurfaceIds().forEach((id) => {
      const entry = inventory.find((surface) => surface.id === id);
      expect(entry).toEqual(expect.objectContaining({
        id,
        name: expect.any(String),
        promptFamily: expect.any(String),
        ownerSurface: expect.any(String),
        sourceFile: expect.any(String),
        exposure: expect.stringMatching(/^(universal|conditional)$/),
      }));
      expect(entry.expectedTests.length).toBeGreaterThan(0);
    });
  });
});

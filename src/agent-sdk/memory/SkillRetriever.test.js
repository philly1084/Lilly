const { SkillRetriever } = require('./SkillRetriever');

function createRetriever() {
  return new SkillRetriever(
    {
      search: jest.fn(),
      findByTrigger: jest.fn(),
    },
    {
      embed: jest.fn(),
    },
  );
}

describe('SkillRetriever', () => {
  test('formats prompt context with exact skill IDs and readable example steps', () => {
    const retriever = createRetriever();

    const prompt = retriever.formatForPrompt([
      {
        id: 'image-website-k3s',
        name: 'Image Website Deployment',
        description: 'Builds an image-led website and deploys it to k3s.',
        toolPreferences: ['image-generate', 'remote-cli-agent'],
        example: {
          steps: [
            { type: 'plan' },
            { type: 'tool-call' },
            { type: 'verify' },
          ],
        },
      },
    ]);

    expect(prompt).toContain('**Image Website Deployment**');
    expect(prompt).toContain('Skill ID: image-website-k3s');
    expect(prompt).toContain('Recommended tools: image-generate, remote-cli-agent');
    expect(prompt).toContain('Example approach: plan -> tool-call -> verify');
    expect(prompt).not.toContain('â†’');
  });
});

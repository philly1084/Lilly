const fs = require('fs');
const path = require('path');

describe('Docker runtime contract', () => {
  const root = path.join(__dirname, '..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  function stageBody(stageName) {
    const pattern = new RegExp(`FROM [^\\n]+ AS ${stageName}\\n([\\s\\S]*?)(?=\\n# =+\\n# Stage|\\nFROM |$)`);
    const match = dockerfile.match(pattern);
    return match ? match[1] : '';
  }

  it('publishes an image target that includes the SSH client used by deploy tools', () => {
    const pushScript = packageJson.scripts['docker:push'];
    const targetMatch = pushScript.match(/--target\s+([^\s]+)/);
    const publishedTarget = targetMatch ? targetMatch[1] : 'final';

    expect(publishedTarget).toBe('media');
    expect(stageBody(publishedTarget)).toContain('openssh-client');
  });

  it('ships registered skills in the runtime image', () => {
    const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');

    expect(dockerfile).toContain('COPY data/skills/ ./data/skills/');
    expect(dockerignore).toContain('!data/skills/');
    expect(dockerignore).toContain('!data/skills/*/');
    expect(dockerignore).toContain('!data/skills/*/*');
  });

  it('ships the remote-agent operational canaries in the runtime image', () => {
    expect(dockerfile).toContain(
      'COPY scripts/canary-remote-agent-artifact-loop.js ./scripts/canary-remote-agent-artifact-loop.js',
    );
    expect(dockerfile).toContain(
      'COPY scripts/canary-sandbox-agent-attach.js ./scripts/canary-sandbox-agent-attach.js',
    );
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('agent soul', () => {
  let tempDir;
  let soulPath;
  let originalSoulPath;
  let agentSoul;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-agent-soul-'));
    soulPath = path.join(tempDir, 'soul.md');
    originalSoulPath = process.env.KIMIBUILT_SOUL_PATH;
    process.env.KIMIBUILT_SOUL_PATH = soulPath;
    agentSoul = require('./agent-soul');
  });

  afterEach(() => {
    if (originalSoulPath === undefined) {
      delete process.env.KIMIBUILT_SOUL_PATH;
    } else {
      process.env.KIMIBUILT_SOUL_PATH = originalSoulPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('exposes Hermes bounded soul metadata', () => {
    const effective = agentSoul.getEffectiveSoulConfig();

    expect(effective.source).toBe('default');
    expect(effective.filePath).toContain('soul.md');
    expect(effective.characterLimit).toBe(3700);
    expect(effective.content).toContain('# Soul');
  });

  test('writes normalized soul content and enforces the hard limit', () => {
    const saved = agentSoul.writeSoulFile('# Soul\r\n- Warm and grounded.');

    expect(saved.content).toBe('# Soul\n- Warm and grounded.\n');
    expect(fs.readFileSync(soulPath, 'utf8')).toBe('# Soul\n- Warm and grounded.\n');
    expect(() => {
      agentSoul.writeSoulFile(`A${'x'.repeat(agentSoul.SOUL_CHAR_LIMIT)}`);
    }).toThrow('soul.md cannot exceed 3700 characters');
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('agent user profile', () => {
  let tempDir;
  let userPath;
  let originalUserPath;
  let userProfile;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-user-profile-'));
    userPath = path.join(tempDir, 'user.md');
    originalUserPath = process.env.KIMIBUILT_USER_PROFILE_PATH;
    process.env.KIMIBUILT_USER_PROFILE_PATH = userPath;
    userProfile = require('./agent-user-profile');
  });

  afterEach(() => {
    if (originalUserPath === undefined) {
      delete process.env.KIMIBUILT_USER_PROFILE_PATH;
    } else {
      process.env.KIMIBUILT_USER_PROFILE_PATH = originalUserPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('reads default user.md profile with Hermes character metadata', () => {
    const effective = userProfile.getEffectiveUserProfileConfig();

    expect(effective.source).toBe('default');
    expect(effective.filePath).toContain('user.md');
    expect(effective.characterLimit).toBe(3700);
    expect(effective.content).toContain('# User');
  });

  test('writes normalized user.md content and enforces the hard limit', () => {
    const saved = userProfile.writeUserProfileFile('# User\r\n- Phil prefers proof.');

    expect(saved.content).toBe('# User\n- Phil prefers proof.\n');
    expect(fs.readFileSync(userPath, 'utf8')).toBe('# User\n- Phil prefers proof.\n');
    expect(() => {
      userProfile.writeUserProfileFile(`A${'x'.repeat(userProfile.USER_PROFILE_CHAR_LIMIT)}`);
    }).toThrow('user.md cannot exceed 3700 characters');
  });

  test('clamps an existing oversized user profile at runtime', () => {
    fs.writeFileSync(userPath, `# User\n${'x'.repeat(userProfile.USER_PROFILE_CHAR_LIMIT + 200)}`, 'utf8');

    const effective = userProfile.getEffectiveUserProfileConfig();

    expect(effective.source).toBe('file-truncated');
    expect(effective.limitExceeded).toBe(true);
    expect(effective.originalCharacterCount).toBeGreaterThan(userProfile.USER_PROFILE_CHAR_LIMIT);
    expect(effective.characterCount).toBeLessThanOrEqual(userProfile.USER_PROFILE_CHAR_LIMIT);
    expect(effective.content).toContain('user.md exceeded 3700 characters');
  });

  test('builds runtime instructions from user.md', () => {
    userProfile.writeUserProfileFile('# User\n- Phil likes concise evidence.');

    const instructions = userProfile.buildUserProfileInstructions();

    expect(instructions).toContain('[User profile memory]');
    expect(instructions).toContain('Hermes-style USER.md');
    expect(instructions).toContain('Phil likes concise evidence');
  });
});

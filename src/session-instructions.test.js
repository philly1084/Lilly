jest.mock('./agent-soul', () => ({
  buildSoulInstructions: jest.fn(() => '[Agent soul]\nSoul content'),
}));

jest.mock('./agent-notes', () => ({
  buildAgentNotesInstructions: jest.fn(() => '[Carryover notes memory]\nNotes content'),
}));

jest.mock('./agent-user-profile', () => ({
  buildUserProfileInstructions: jest.fn(() => '[User profile memory]\nUser content'),
}));

jest.mock('./asset-manager', () => ({
  buildAssetManagerInstructions: jest.fn(() => '[Indexed asset manager]\nAsset search content'),
}));

jest.mock('./business-agent', () => ({
  isDefaultBusinessAgentProfile: jest.fn(() => false),
}));

jest.mock('./project-memory', () => ({
  buildProjectMemoryInstructions: jest.fn(() => ''),
}));

jest.mock('./session-compaction', () => ({
  buildSessionCompactionInstructions: jest.fn(() => ''),
}));

jest.mock('./routes/admin/settings.controller', () => ({
  settings: {
    personality: {
      enabled: true,
      displayName: 'Agent Soul',
    },
    agentNotes: {
      enabled: true,
      displayName: 'Carryover Notes',
    },
    userProfile: {
      enabled: true,
      displayName: 'User Profile',
    },
  },
}));

jest.mock('./runtime-control-state', () => ({
  getSessionControlState: jest.fn(() => ({})),
}));

const { buildSoulInstructions } = require('./agent-soul');
const { buildAgentNotesInstructions } = require('./agent-notes');
const { buildUserProfileInstructions } = require('./agent-user-profile');
const { buildAssetManagerInstructions } = require('./asset-manager');
const { buildSessionCompactionInstructions } = require('./session-compaction');
const {
  buildHumanCentricResponseInstructions,
  buildSessionInstructions,
} = require('./session-instructions');

describe('buildSessionInstructions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildSoulInstructions.mockReturnValue('[Agent soul]\nSoul content');
    buildUserProfileInstructions.mockReturnValue('[User profile memory]\nUser content');
    buildAgentNotesInstructions.mockReturnValue('[Carryover notes memory]\nNotes content');
    buildAssetManagerInstructions.mockReturnValue('[Indexed asset manager]\nAsset search content');
    buildSessionCompactionInstructions.mockReturnValue('');
  });

  test('injects the shared soul, user profile, carryover notes, and indexed asset guidance between base instructions and saved agent metadata', () => {
    const result = buildSessionInstructions({
      metadata: {
        agent: {
          instructions: 'Stay sharp.',
          name: 'Kimi',
          tools: ['remote-command', 'git-safe'],
        },
      },
    }, 'Base instructions');

    expect(buildSoulInstructions).toHaveBeenCalledWith({
      enabled: true,
      displayName: 'Agent Soul',
    });
    expect(buildUserProfileInstructions).toHaveBeenCalledWith({
      enabled: true,
      displayName: 'User Profile',
    });
    expect(buildAgentNotesInstructions).toHaveBeenCalledWith({
      enabled: true,
      displayName: 'Carryover Notes',
    });
    expect(buildAssetManagerInstructions).toHaveBeenCalled();
    expect(result).toContain('Base instructions');
    expect(result).toContain('[Agent soul]\nSoul content');
    expect(result).toContain('[User profile memory]\nUser content');
    expect(result).toContain('[Carryover notes memory]\nNotes content');
    expect(result).toContain('[Indexed asset manager]\nAsset search content');
    expect(result).toContain('Saved agent profile: Stay sharp.');
    expect(result).toContain('Agent name: Kimi');
    expect(result).toContain('Preferred workflow tools: remote-command, git-safe.');
    expect(result.indexOf('[Agent soul]')).toBeGreaterThan(result.indexOf('Base instructions'));
    expect(result.indexOf('[User profile memory]')).toBeGreaterThan(result.indexOf('[Agent soul]'));
    expect(result.indexOf('[Carryover notes memory]')).toBeGreaterThan(result.indexOf('[User profile memory]'));
    expect(result.indexOf('[Indexed asset manager]')).toBeGreaterThan(result.indexOf('[Carryover notes memory]'));
    expect(result.indexOf('Saved agent profile: Stay sharp.')).toBeGreaterThan(result.indexOf('[Indexed asset manager]'));
  });

  test('omits the soul, notes, and asset blocks when none are active', () => {
    buildSoulInstructions.mockReturnValueOnce('');
    buildUserProfileInstructions.mockReturnValueOnce('');
    buildAgentNotesInstructions.mockReturnValueOnce('');
    buildAssetManagerInstructions.mockReturnValueOnce('');

    const result = buildSessionInstructions({
      metadata: {},
    }, 'Base instructions');

    expect(result).toBe('Base instructions');
  });

  test('replaces cross-session carryover blocks with an isolation notice for isolated sessions', () => {
    const result = buildSessionInstructions({
      metadata: {
        sessionIsolation: true,
      },
    }, 'Base instructions');

    expect(result).toContain('Base instructions');
    expect(result).toContain('[Session isolation]');
    expect(result).toContain('Treat this chat as isolated from other chats by default.');
    expect(result).not.toContain('[User profile memory]');
    expect(result).not.toContain('[Carryover notes memory]');
    expect(result).not.toContain('[Indexed asset manager]');
  });

  test('includes the session compaction carryover block for isolated sessions', () => {
    buildSessionCompactionInstructions.mockReturnValue('[Session compaction]\nCompacted summary');

    const result = buildSessionInstructions({
      metadata: {
        sessionIsolation: true,
      },
    }, 'Base instructions');

    expect(buildSessionCompactionInstructions).toHaveBeenCalled();
    expect(result).toContain('[Session isolation]');
    expect(result).toContain('[Session compaction]\nCompacted summary');
  });

  test('builds human-facing formatting guidance for CLI and web chat surfaces', () => {
    const cli = buildHumanCentricResponseInstructions({
      clientSurface: 'cli',
      taskType: 'chat',
    });
    const webChat = buildHumanCentricResponseInstructions({
      clientSurface: 'web-chat',
      taskType: 'chat',
    });

    expect(cli).toContain('[Human-facing response format]');
    expect(cli).toContain('terminal Markdown view');
    expect(webChat).toContain('web chat Markdown view');
    expect(webChat).toContain('If the user asks for exact text');
  });

  test('skips human-facing formatting guidance for non-chat task surfaces', () => {
    const result = buildHumanCentricResponseInstructions({
      clientSurface: 'notation',
      taskType: 'notation',
    });

    expect(result).toBe('');
  });
});

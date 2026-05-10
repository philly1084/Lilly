jest.mock('fs', () => ({
  statSync: jest.fn(() => ({
    mtime: new Date('2026-04-04T00:00:00.000Z'),
  })),
}));

jest.mock('../../agent-soul', () => ({
  getEffectiveSoulConfig: jest.fn((settings = {}) => ({
    enabled: settings.enabled !== false,
    displayName: settings.displayName || 'Agent Soul',
    content: '# Soul\nCurrent soul content\n',
    absoluteFilePath: 'C:/Users/phill/KimiBuilt/soul.md',
    updatedAt: '2026-04-04T00:00:00.000Z',
  })),
  writeSoulFile: jest.fn(),
}));

jest.mock('../../agent-notes', () => ({
  getEffectiveAgentNotesConfig: jest.fn((settings = {}) => ({
    enabled: settings.enabled !== false,
    displayName: settings.displayName || 'Carryover Notes',
    content: '# Carryover Notes\nCurrent carryover content\n',
    absoluteFilePath: 'C:/Users/phill/KimiBuilt/agent-notes.md',
    updatedAt: '2026-04-04T00:00:00.000Z',
  })),
  writeAgentNotesFile: jest.fn(),
}));

jest.mock('../../artifacts/artifact-service', () => ({
  artifactService: {
    getArtifactPlanInstructions: jest.fn(() => 'plan prompt'),
    getArtifactExpansionInstructions: jest.fn(() => 'expand prompt'),
    getArtifactCompositionInstructions: jest.fn(() => 'compose prompt'),
  },
}));

jest.mock('../../runtime-prompts', () => ({
  buildContinuityInstructions: jest.fn(() => 'continuity prompt'),
}));

jest.mock('./settings.controller', () => ({
  settings: {
    personality: {
      enabled: true,
      displayName: 'Agent Soul',
    },
  },
  deepMerge: jest.fn((target = {}, source = {}) => {
    const result = { ...target };
    Object.keys(source || {}).forEach((key) => {
      const sourceValue = source[key];
      if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
        result[key] = {
          ...(target[key] || {}),
          ...sourceValue,
        };
      } else {
        result[key] = sourceValue;
      }
    });
    return result;
  }),
  saveSettings: jest.fn().mockResolvedValue(),
}));

const soulHelpers = require('../../agent-soul');
const agentNotesHelpers = require('../../agent-notes');
const settingsController = require('./settings.controller');
const promptsController = require('./prompts.controller');

describe('admin prompts controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    settingsController.settings = {
      personality: {
        enabled: true,
        displayName: 'Agent Soul',
      },
      agentNotes: {
        enabled: true,
        displayName: 'Carryover Notes',
      },
    };
  });

  test('marks the agent soul surface as editable', async () => {
    const res = {
      json: jest.fn(),
    };

    await promptsController.getAll({ query: {} }, res);

    const payload = res.json.mock.calls[0][0];
    const soulPrompt = payload.data.find((entry) => entry.id === 'agent-soul');
    const continuityPrompt = payload.data.find((entry) => entry.id === 'chat-continuity');

    expect(payload.readonly).toBe(false);
    expect(soulPrompt).toEqual(expect.objectContaining({
      id: 'agent-soul',
      name: 'Agent Soul',
      editable: true,
    }));
    expect(continuityPrompt.editable).toBe(false);
  });

  test('updates the agent soul surface and persists the renamed display name', async () => {
    const req = {
      params: { id: 'agent-soul' },
      body: {
        name: 'Operations Soul',
        content: '# Soul\nUpdated from prompts tab\n',
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await promptsController.update(req, res);

    expect(soulHelpers.writeSoulFile).toHaveBeenCalledWith('# Soul\nUpdated from prompts tab\n');
    expect(settingsController.deepMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        personality: expect.objectContaining({
          enabled: true,
          displayName: 'Agent Soul',
        }),
      }),
      {
        personality: {
          displayName: 'Operations Soul',
        },
      },
    );
    expect(settingsController.saveSettings).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      readonly: false,
      data: expect.objectContaining({
        id: 'agent-soul',
        name: 'Operations Soul',
        editable: true,
      }),
    }));
  });

  test('updates the carryover notes surface and persists the renamed display name', async () => {
    const req = {
      params: { id: 'agent-notes' },
      body: {
        name: 'Phil Carryover',
        content: '# Carryover Notes\n- Phil prefers terse status updates.\n',
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await promptsController.update(req, res);

    expect(agentNotesHelpers.writeAgentNotesFile).toHaveBeenCalledWith('# Carryover Notes\n- Phil prefers terse status updates.\n');
    expect(settingsController.deepMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        agentNotes: expect.objectContaining({
          enabled: true,
          displayName: 'Carryover Notes',
        }),
      }),
      {
        agentNotes: {
          displayName: 'Phil Carryover',
        },
      },
    );
    expect(settingsController.saveSettings).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      readonly: false,
      data: expect.objectContaining({
        id: 'agent-notes',
        name: 'Phil Carryover',
        editable: true,
      }),
    }));
  });

  test('rejects edits to code-backed prompt surfaces', async () => {
    const req = {
      params: { id: 'chat-continuity' },
      body: {
        name: 'Chat Continuity Instructions',
        content: 'override',
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await promptsController.update(req, res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(soulHelpers.writeSoulFile).not.toHaveBeenCalled();
    expect(agentNotesHelpers.writeAgentNotesFile).not.toHaveBeenCalled();
    expect(settingsController.saveSettings).not.toHaveBeenCalled();
  });

  test('planner prompt maps remote CLI language to remote-command', () => {
    const prompt = promptsController.getSurfaceById('conversation-planner');

    expect(prompt.content).toContain('Treat "remote CLI", "direct CLI", and "remote command" as aliases for the `remote-command` tool.');
    expect(prompt.content).toContain('prefer `remote-cli-agent` so the remote coding agent owns authoring, build, deploy, and verification');
    expect(prompt.content).toContain('pass `params.adminMode:true`');
    expect(prompt.content).toContain('Impressive Frontend Websites standard');
    expect(prompt.content).toContain('use GitLab as the normal source-control layer');
    expect(prompt.content).toContain('USER_INPUT_REQUIRED');
    expect(prompt.content).toContain('avoid indentation-sensitive inline Python or YAML heredocs');
  });

  test('exposes inventory-only prompt surfaces for request-time prompts', () => {
    const surfaces = promptsController.getSurfaces();
    const ids = surfaces.map((surface) => surface.id);

    expect(ids).toEqual(expect.arrayContaining([
      'canvas-generation',
      'notation-helper',
      'remote-cli-agent',
      'tool-doc-guidance',
      'skill-guidance',
    ]));

    const canvas = surfaces.find((surface) => surface.id === 'canvas-generation');
    expect(canvas).toEqual(expect.objectContaining({
      inventoryOnly: true,
      editable: false,
      promptFamily: 'canvas',
      ownerSurface: '/api/canvas',
      expectedTests: expect.arrayContaining(['src/routes/canvas.test.js']),
    }));
    expect(canvas.content).toContain('The exact prompt is rendered at request time');

    const continuity = surfaces.find((surface) => surface.id === 'chat-continuity');
    expect(continuity).toEqual(expect.objectContaining({
      promptFamily: 'runtime',
      ownerSurface: '/api/chat and OpenAI-compatible routes',
      expectedTests: expect.arrayContaining(['src/openai-client.test.js']),
    }));
    expect(continuity).not.toHaveProperty('inventoryOnly');
  });
});
